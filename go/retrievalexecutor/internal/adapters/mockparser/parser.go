package mockparser

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

type Adapter struct{}

func NewAdapter() *Adapter {
	return &Adapter{}
}

func (a *Adapter) Parse(_ context.Context, request ingestion.ParseRequest) (ingestion.ParseResult, error) {
	start := time.Now()
	text := fmt.Sprintf(
		"Mock parsed document for %s. This parser boundary is frozen before production parser integration. Source uri: %s.",
		request.Source.Filename,
		request.Source.URI,
	)

	pageCount := 1
	return ingestion.ParseResult{
		ParserBackend: "mock",
		ParserName:    "go-mock-parser",
		ParserVersion: "phase1",
		Status:        ingestion.StatusSucceeded,
		Warnings: []string{
			"Mock parser output is active. Replace parser adapter implementation in the next phase.",
		},
		ParsedDocument: &ingestion.ParsedDocument{
			DocumentID: request.DocumentID,
			Title:      request.Source.Filename,
			MimeType:   request.Source.MimeType,
			Language:   "",
			CharCount:  len(text),
			PageCount:  &pageCount,
			Metadata: map[string]any{
				"sourceUri": request.Source.URI,
				"mock":      true,
			},
			Text: text,
			Sections: []ingestion.ParsedSection{
				{
					SectionID: "mock-section-1",
					Title:     "Mock Section",
					Level:     1,
					Text:      strings.TrimSpace(text),
				},
			},
		},
		Metrics: ingestion.ParserMetrics{
			ParseDurationMs: time.Since(start).Milliseconds(),
		},
	}, nil
}
