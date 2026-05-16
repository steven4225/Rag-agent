package pdfparser

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	parsererrors "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/parsererrors"
	parsersource "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/source"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

const parserSource = "parser-pdf"

var lookupCommandPath = exec.LookPath

type Adapter struct{}

func NewAdapter() *Adapter {
	return &Adapter{}
}

func (a *Adapter) Parse(ctx context.Context, request ingestion.ParseRequest) (ingestion.ParseResult, error) {
	start := time.Now()
	resolvedMimeType := parsersource.DetectKind(request.Source.MimeType, request.Source.Filename, request.Source.URI)
	if resolvedMimeType != parsersource.KindPDF {
		return ingestion.ParseResult{}, parsererrors.UnsupportedFormat(parserSource, fmt.Sprintf("pdf parser does not support mime type %s", resolvedMimeType), nil)
	}

	pdfToTextBinary, err := lookupCommandPath("pdftotext")
	if err != nil {
		return ingestion.ParseResult{}, parsererrors.DependencyMissing(parserSource, "missing dependency binary: pdftotext", err)
	}

	contentBytes, sourceScheme, err := parsersource.ReadSourceBytes(request.Source.URI, parserSource)
	if err != nil {
		return ingestion.ParseResult{}, err
	}
	if len(contentBytes) == 0 {
		return ingestion.ParseResult{}, parsererrors.ParseFailed(parserSource, "parsed document is empty", nil)
	}

	tempFile, err := os.CreateTemp("", "ragent-parser-*.pdf")
	if err != nil {
		return ingestion.ParseResult{}, parsererrors.FileReadFailed(parserSource, "failed to create temp file for pdf parser", true, err)
	}
	tempPath := tempFile.Name()
	defer os.Remove(tempPath)

	if _, err := tempFile.Write(contentBytes); err != nil {
		_ = tempFile.Close()
		return ingestion.ParseResult{}, parsererrors.FileReadFailed(parserSource, "failed to write pdf content to temp file", true, err)
	}
	if err := tempFile.Close(); err != nil {
		return ingestion.ParseResult{}, parsererrors.FileReadFailed(parserSource, "failed to close temp file for pdf parser", true, err)
	}

	command := exec.CommandContext(ctx, pdfToTextBinary, "-layout", "-enc", "UTF-8", tempPath, "-")
	output, err := command.Output()
	if err != nil {
		parseErr := parsererrors.ParseFailed(parserSource, "pdftotext execution failed", err)
		if exitErr, ok := err.(*exec.ExitError); ok {
			stderr := strings.TrimSpace(string(exitErr.Stderr))
			if stderr != "" {
				parseErr = parsererrors.ParseFailed(parserSource, "pdftotext execution failed: "+stderr, err)
			}
		}
		return ingestion.ParseResult{}, parseErr
	}

	normalizedText := parsersource.NormalizeLineEndings(strings.ReplaceAll(string(output), "\f", "\n\n"))
	if normalizedText == "" {
		return ingestion.ParseResult{}, parsererrors.ParseFailed(parserSource, "pdf parser returned empty text output", nil)
	}

	title := parsersource.FallbackTitle(request.Source.Filename, "Untitled pdf document")
	pageCount := detectPageCount(output)
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

	document := &ingestion.ParsedDocument{
		DocumentID: request.DocumentID,
		Title:      title,
		MimeType:   parsersource.KindPDF,
		Language:   "",
		CharCount:  len(normalizedText),
		PageCount:  pageCount,
		Metadata: map[string]any{
			"sourceScheme": sourceScheme,
			"parserType":   request.Plan.Parser.ParserType,
			"dependency":   "pdftotext",
		},
		Text:     normalizedText,
		Sections: sections,
	}

	return ingestion.ParseResult{
		ParserBackend: "simple",
		ParserName:    "go-pdf-parser",
		ParserVersion: "phase1",
		Status:        ingestion.StatusSucceeded,
		Warnings: []string{
			"PDF parser phase 1 extracts plain text only, without OCR or layout/table reconstruction.",
		},
		ParsedDocument: document,
		Metrics: ingestion.ParserMetrics{
			ParseDurationMs: time.Since(start).Milliseconds(),
		},
	}, nil
}

func detectPageCount(rawOutput []byte) *int {
	parts := bytes.Split(rawOutput, []byte{'\f'})
	nonEmptyParts := 0
	for _, part := range parts {
		if strings.TrimSpace(string(part)) != "" {
			nonEmptyParts++
		}
	}
	if nonEmptyParts == 0 {
		return nil
	}
	return &nonEmptyParts
}
