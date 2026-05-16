package tikaparser

import (
	"context"
	"fmt"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	parsererrors "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/parsererrors"
	parsersource "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/source"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

const (
	parserSource        = "parser-tika"
	defaultParserName   = "go-tika-parser"
	defaultParserVerion = "phase1"
)

type Config struct {
	BaseURL string
	Timeout time.Duration
	Client  *http.Client
}

type Adapter struct {
	baseURL string
	client  *Client
}

func NewAdapter(config Config) *Adapter {
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}

	httpClient := config.Client
	if httpClient == nil {
		httpClient = &http.Client{Timeout: timeout}
	}

	baseURL := strings.TrimSpace(config.BaseURL)
	return &Adapter{
		baseURL: baseURL,
		client:  NewClient(baseURL, httpClient),
	}
}

func (a *Adapter) Parse(ctx context.Context, request ingestion.ParseRequest) (ingestion.ParseResult, error) {
	if strings.TrimSpace(a.baseURL) == "" {
		return ingestion.ParseResult{}, parsererrors.DependencyMissing(parserSource, "PARSER_TIKA_URL is not configured", nil)
	}

	contentBytes, sourceScheme, err := parsersource.ReadSourceBytes(request.Source.URI, parserSource)
	if err != nil {
		return ingestion.ParseResult{}, err
	}
	if len(contentBytes) == 0 {
		return ingestion.ParseResult{}, parsererrors.ParseFailed(parserSource, "parsed document is empty", nil)
	}

	startedAt := time.Now()
	resolvedMimeType := parsersource.DetectKind(request.Source.MimeType, request.Source.Filename, request.Source.URI)
	extractedText, err := a.client.ExtractText(ctx, resolvedMimeType, contentBytes)
	if err != nil {
		return ingestion.ParseResult{}, err
	}
	if strings.TrimSpace(extractedText) == "" {
		return ingestion.ParseResult{}, parsererrors.ParseFailed(parserSource, "tika parser returned empty text output", nil)
	}

	metadata, err := a.client.ExtractMetadata(ctx, resolvedMimeType, contentBytes)
	if err != nil {
		return ingestion.ParseResult{}, err
	}
	if metadata == nil {
		metadata = map[string]any{}
	}

	title := firstNonEmptyString(
		metadata["title"],
		metadata["dc:title"],
		parsersource.FallbackTitle(request.Source.Filename, "Untitled document"),
	)
	pageCount := extractPageCount(metadata)
	normalizedText := parsersource.NormalizeLineEndings(extractedText)
	sections := []ingestion.ParsedSection{
		{
			SectionID:   "section-1",
			Title:       title,
			Level:       1,
			Text:        normalizedText,
			StartOffset: 0,
			EndOffset:   len(normalizedText),
		},
	}

	tikaMetadataKeys := make([]string, 0, len(metadata))
	for key := range metadata {
		tikaMetadataKeys = append(tikaMetadataKeys, key)
	}
	sort.Strings(tikaMetadataKeys)

	document := &ingestion.ParsedDocument{
		DocumentID: request.DocumentID,
		Title:      title,
		MimeType:   resolvedMimeType,
		Language:   firstNonEmptyString(metadata["language"], metadata["dc:language"], ""),
		CharCount:  len(normalizedText),
		PageCount:  pageCount,
		Metadata: map[string]any{
			"sourceScheme":      sourceScheme,
			"parserType":        request.Plan.Parser.ParserType,
			"parserBackend":     "tika",
			"tikaUrl":           a.baseURL,
			"tikaContentType":   resolvedMimeType,
			"tikaMetadataKeys":  tikaMetadataKeys,
			"tikaMetadata":      metadata,
			"sourceFilename":    filepath.Base(request.Source.Filename),
			"metadataExtracted": true,
		},
		Text:     normalizedText,
		Sections: sections,
	}

	return ingestion.ParseResult{
		ParserBackend: "tika",
		ParserName:    defaultParserName,
		ParserVersion: defaultParserVerion,
		Status:        ingestion.StatusSucceeded,
		Warnings: []string{
			"Tika parser phase 1 extracts plain text and metadata only, without OCR or layout/table fidelity.",
		},
		ParsedDocument: document,
		Metrics: ingestion.ParserMetrics{
			ParseDurationMs: time.Since(startedAt).Milliseconds(),
		},
	}, nil
}

func firstNonEmptyString(values ...any) string {
	for _, item := range values {
		if value, ok := item.(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func extractPageCount(metadata map[string]any) *int {
	candidates := []string{
		"xmpTPg:NPages",
		"meta:page-count",
		"pdf:docinfo:pageCount",
		"Page-Count",
		"pageCount",
	}
	for _, key := range candidates {
		value, ok := metadata[key]
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case float64:
			if typed > 0 {
				result := int(typed)
				return &result
			}
		case int:
			if typed > 0 {
				result := typed
				return &result
			}
		case int64:
			if typed > 0 {
				result := int(typed)
				return &result
			}
		case string:
			trimmed := strings.TrimSpace(typed)
			if trimmed == "" {
				continue
			}
			if parsed, err := parsePositiveInt(trimmed); err == nil {
				return &parsed
			}
		}
	}
	return nil
}

func parsePositiveInt(value string) (int, error) {
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, err
	}
	if parsed <= 0 {
		return 0, fmt.Errorf("value must be positive: %s", value)
	}
	return parsed, nil
}
