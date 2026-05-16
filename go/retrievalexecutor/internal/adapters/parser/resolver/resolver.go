package resolver

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	docxparser "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/docxparser"
	parsererrors "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/parsererrors"
	pdfparser "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/pdfparser"
	parsersource "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/source"
	textparser "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/textparser"
	tikaparser "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/tikaparser"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

const (
	ProviderText   = "text"
	ProviderSimple = "simple"
	ProviderTika   = "tika"
	ProviderAuto   = "auto"
)

type Config struct {
	Provider            string
	PDFEnabled          bool
	DOCXEnabled         bool
	TikaURL             string
	TikaFallbackEnabled bool
	TikaTimeoutMs       int
}

type Adapter struct {
	config Config
	text   ingestion.ParserAdapter
	pdf    ingestion.ParserAdapter
	docx   ingestion.ParserAdapter
	tika   ingestion.ParserAdapter
}

func ResolveFromEnv() ingestion.ParserAdapter {
	config := Config{
		Provider:            strings.ToLower(strings.TrimSpace(os.Getenv("PARSER_PROVIDER"))),
		PDFEnabled:          parseBool(os.Getenv("PARSER_PDF_ENABLED"), true),
		DOCXEnabled:         parseBool(os.Getenv("PARSER_DOCX_ENABLED"), true),
		TikaURL:             strings.TrimSpace(os.Getenv("PARSER_TIKA_URL")),
		TikaFallbackEnabled: parseBool(os.Getenv("PARSER_TIKA_FALLBACK_ENABLED"), true),
		TikaTimeoutMs:       parseInt(os.Getenv("PARSER_TIKA_TIMEOUT_MS"), 15000),
	}
	return Resolve(config)
}

func Resolve(config Config) ingestion.ParserAdapter {
	normalizedConfig := config
	normalizedConfig.Provider = normalizeProvider(config.Provider)
	if normalizedConfig.TikaTimeoutMs <= 0 {
		normalizedConfig.TikaTimeoutMs = 15000
	}

	return &Adapter{
		config: normalizedConfig,
		text:   textparser.NewAdapter(),
		pdf:    pdfparser.NewAdapter(),
		docx:   docxparser.NewAdapter(),
		tika: tikaparser.NewAdapter(tikaparser.Config{
			BaseURL: normalizedConfig.TikaURL,
			Timeout: time.Duration(normalizedConfig.TikaTimeoutMs) * time.Millisecond,
		}),
	}
}

func (a *Adapter) Parse(ctx context.Context, request ingestion.ParseRequest) (ingestion.ParseResult, error) {
	selected, err := a.selectAdapter(request.Source)
	if err != nil {
		return ingestion.ParseResult{}, err
	}

	result, err := selected.primary.Parse(ctx, request)
	if err == nil {
		return finalizeResult(result, selected, nil), nil
	}

	if !selected.allowFallback || selected.fallback == nil {
		return ingestion.ParseResult{}, err
	}

	fallbackResult, fallbackErr := selected.fallback.Parse(ctx, request)
	if fallbackErr != nil {
		return ingestion.ParseResult{}, fallbackErr
	}
	return finalizeResult(fallbackResult, selected, err), nil
}

type adapterSelection struct {
	primary       ingestion.ParserAdapter
	fallback      ingestion.ParserAdapter
	primaryName   string
	allowFallback bool
}

func (a *Adapter) selectAdapter(source ingestion.Source) (adapterSelection, error) {
	kind := parsersource.DetectKind(source.MimeType, source.Filename, source.URI)

	switch a.config.Provider {
	case ProviderText:
		return adapterSelection{
			primary:     a.text,
			primaryName: ProviderText,
		}, nil
	case ProviderSimple:
		selected, err := a.selectSimpleAdapter(kind)
		if err != nil {
			return adapterSelection{}, err
		}
		return selected, nil
	case ProviderTika:
		selection := adapterSelection{
			primary:       a.tika,
			primaryName:   ProviderTika,
			allowFallback: a.config.TikaFallbackEnabled,
		}
		if a.config.TikaFallbackEnabled {
			fallbackSelection, err := a.selectSimpleAdapter(kind)
			if err == nil {
				selection.fallback = fallbackSelection.primary
			}
		}
		return selection, nil
	default:
		return a.selectAutoAdapter(kind)
	}
}

func (a *Adapter) selectAutoAdapter(kind string) (adapterSelection, error) {
	switch kind {
	case parsersource.KindPDF:
		simpleSelection, err := a.selectSimpleAdapter(kind)
		if err != nil {
			return adapterSelection{}, err
		}
		if strings.TrimSpace(a.config.TikaURL) == "" {
			return simpleSelection, nil
		}
		return adapterSelection{
			primary:       a.tika,
			fallback:      simpleSelection.primary,
			primaryName:   ProviderTika,
			allowFallback: a.config.TikaFallbackEnabled,
		}, nil
	case parsersource.KindDOCX:
		simpleSelection, err := a.selectSimpleAdapter(kind)
		if err != nil {
			return adapterSelection{}, err
		}
		if strings.TrimSpace(a.config.TikaURL) == "" {
			return simpleSelection, nil
		}
		return adapterSelection{
			primary:       a.tika,
			fallback:      simpleSelection.primary,
			primaryName:   ProviderTika,
			allowFallback: a.config.TikaFallbackEnabled,
		}, nil
	case parsersource.KindPlainText, parsersource.KindMarkdown:
		return adapterSelection{
			primary:     a.text,
			primaryName: ProviderText,
		}, nil
	default:
		return adapterSelection{}, parsererrors.UnsupportedFormat("parser-resolver", fmt.Sprintf("unsupported source format: %s", kind), nil)
	}
}

func (a *Adapter) selectSimpleAdapter(kind string) (adapterSelection, error) {
	switch kind {
	case parsersource.KindPDF:
		if !a.config.PDFEnabled {
			return adapterSelection{}, parsererrors.UnsupportedFormat("parser-resolver", "pdf parser is disabled by PARSER_PDF_ENABLED=false", nil)
		}
		return adapterSelection{
			primary:     a.pdf,
			primaryName: ProviderSimple,
		}, nil
	case parsersource.KindDOCX:
		if !a.config.DOCXEnabled {
			return adapterSelection{}, parsererrors.UnsupportedFormat("parser-resolver", "docx parser is disabled by PARSER_DOCX_ENABLED=false", nil)
		}
		return adapterSelection{
			primary:     a.docx,
			primaryName: ProviderSimple,
		}, nil
	case parsersource.KindPlainText, parsersource.KindMarkdown:
		return adapterSelection{
			primary:     a.text,
			primaryName: ProviderText,
		}, nil
	default:
		return adapterSelection{}, parsererrors.UnsupportedFormat("parser-resolver", fmt.Sprintf("unsupported source format: %s", kind), nil)
	}
}

func parseBool(value string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true":
		return true
	case "false":
		return false
	default:
		return fallback
	}
}

func parseInt(value string, fallback int) int {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(trimmed)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func normalizeProvider(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case ProviderText:
		return ProviderText
	case ProviderSimple:
		return ProviderSimple
	case ProviderTika:
		return ProviderTika
	case ProviderAuto:
		return ProviderAuto
	default:
		return ProviderAuto
	}
}

func finalizeResult(result ingestion.ParseResult, selection adapterSelection, primaryErr error) ingestion.ParseResult {
	if strings.TrimSpace(result.ParserBackend) == "" {
		result.ParserBackend = selection.primaryName
	}

	if result.ParsedDocument == nil {
		return result
	}
	if result.ParsedDocument.Metadata == nil {
		result.ParsedDocument.Metadata = map[string]any{}
	}
	result.ParsedDocument.Metadata["parserBackend"] = result.ParserBackend
	result.ParsedDocument.Metadata["parserName"] = result.ParserName
	result.ParsedDocument.Metadata["parserVersion"] = result.ParserVersion

	if primaryErr == nil {
		return result
	}
	fallbackReason := "tika-backend-unavailable"
	if reason, ok := extractErrorCode(primaryErr); ok {
		fallbackReason = reason
	}
	result.ParsedDocument.Metadata["fallbackReason"] = fallbackReason
	result.ParsedDocument.Metadata["fallbackFromParserBackend"] = selection.primaryName
	result.Warnings = append(result.Warnings, "tika parser fallback applied: "+fallbackReason)
	return result
}

func extractErrorCode(err error) (string, bool) {
	type codeError interface{ ErrorCode() string }
	var target codeError
	if ok := errors.As(err, &target); ok {
		code := strings.TrimSpace(target.ErrorCode())
		if code != "" {
			return code, true
		}
	}
	return "", false
}
