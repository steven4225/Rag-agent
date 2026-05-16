package resolver

import (
	"context"
	"errors"
	"testing"

	parsererrors "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/parsererrors"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

type mockParser struct {
	name string
	err  error
}

func (m mockParser) Parse(_ context.Context, request ingestion.ParseRequest) (ingestion.ParseResult, error) {
	if m.err != nil {
		return ingestion.ParseResult{}, m.err
	}
	return ingestion.ParseResult{
		ParserBackend: m.name,
		ParserName:    m.name,
		Status:        ingestion.StatusSucceeded,
		ParsedDocument: &ingestion.ParsedDocument{
			DocumentID: request.DocumentID,
			Title:      "test",
			MimeType:   request.Source.MimeType,
			CharCount:  1,
			Text:       "x",
			Sections: []ingestion.ParsedSection{
				{
					SectionID:   "section-1",
					Title:       "test",
					Level:       1,
					Text:        "x",
					StartOffset: 0,
					EndOffset:   1,
				},
			},
		},
	}, nil
}

func TestAdapterSelectsTextForMarkdown(t *testing.T) {
	adapter := &Adapter{
		config: Config{
			Provider:    ProviderAuto,
			PDFEnabled:  true,
			DOCXEnabled: true,
		},
		text: mockParser{name: "text"},
		pdf:  mockParser{name: "pdf"},
		docx: mockParser{name: "docx"},
		tika: mockParser{name: "tika"},
	}

	result, err := adapter.Parse(context.Background(), ingestion.ParseRequest{
		DocumentID: "doc1",
		Source: ingestion.Source{
			Filename: "policy.md",
			MimeType: "text/markdown",
			URI:      "data:text/markdown;base64,SGVsbG8=",
		},
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result.ParserName != "text" {
		t.Fatalf("expected text parser selected, got %s", result.ParserName)
	}
}

func TestAdapterRejectsPDFWhenDisabled(t *testing.T) {
	adapter := &Adapter{
		config: Config{
			Provider:    ProviderAuto,
			PDFEnabled:  false,
			DOCXEnabled: true,
		},
		text: mockParser{name: "text"},
		pdf:  mockParser{name: "pdf"},
		docx: mockParser{name: "docx"},
		tika: mockParser{name: "tika"},
	}

	_, err := adapter.Parse(context.Background(), ingestion.ParseRequest{
		DocumentID: "doc1",
		Source: ingestion.Source{
			Filename: "sample.pdf",
			MimeType: "application/pdf",
			URI:      "file:///tmp/sample.pdf",
		},
	})
	if err == nil {
		t.Fatalf("expected error when PDF parser is disabled")
	}

	type codeError interface {
		ErrorCode() string
	}
	var coded codeError
	if !errors.As(err, &coded) {
		t.Fatalf("expected coded parser error, got %T", err)
	}
	if coded.ErrorCode() != "unsupported-format" {
		t.Fatalf("expected unsupported-format code, got %s", coded.ErrorCode())
	}
}

func TestAdapterSelectsProviderTextMode(t *testing.T) {
	adapter := &Adapter{
		config: Config{
			Provider:    ProviderText,
			PDFEnabled:  true,
			DOCXEnabled: true,
		},
		text: mockParser{name: "text"},
		pdf:  mockParser{name: "pdf"},
		docx: mockParser{name: "docx"},
		tika: mockParser{name: "tika"},
	}

	result, err := adapter.Parse(context.Background(), ingestion.ParseRequest{
		DocumentID: "doc1",
		Source: ingestion.Source{
			Filename: "sample.pdf",
			MimeType: "application/pdf",
			URI:      "file:///tmp/sample.pdf",
		},
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result.ParserName != "text" {
		t.Fatalf("expected text parser selected in PARSER_PROVIDER=text mode, got %s", result.ParserName)
	}
}

func TestAdapterSelectsSimpleProviderForPDF(t *testing.T) {
	adapter := &Adapter{
		config: Config{
			Provider:    ProviderSimple,
			PDFEnabled:  true,
			DOCXEnabled: true,
		},
		text: mockParser{name: "text"},
		pdf:  mockParser{name: "pdf"},
		docx: mockParser{name: "docx"},
		tika: mockParser{name: "tika"},
	}

	result, err := adapter.Parse(context.Background(), ingestion.ParseRequest{
		DocumentID: "doc1",
		Source: ingestion.Source{
			Filename: "sample.pdf",
			MimeType: "application/pdf",
			URI:      "data:application/pdf;base64,ZmFrZS1wZGY=",
		},
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result.ParserName != "pdf" {
		t.Fatalf("expected pdf parser selected in PARSER_PROVIDER=simple mode, got %s", result.ParserName)
	}
}

func TestAdapterFallbacksFromTikaWhenEnabled(t *testing.T) {
	adapter := &Adapter{
		config: Config{
			Provider:            ProviderTika,
			PDFEnabled:          true,
			DOCXEnabled:         true,
			TikaURL:             "http://localhost:9998",
			TikaFallbackEnabled: true,
		},
		text: mockParser{name: "text"},
		pdf:  mockParser{name: "pdf"},
		docx: mockParser{name: "docx"},
		tika: mockParser{name: "tika", err: parsererrors.BackendUnavailable("parser-tika", "offline", true, nil)},
	}

	result, err := adapter.Parse(context.Background(), ingestion.ParseRequest{
		DocumentID: "doc1",
		Source: ingestion.Source{
			Filename: "sample.pdf",
			MimeType: "application/pdf",
			URI:      "data:application/pdf;base64,ZmFrZS1wZGY=",
		},
	})
	if err != nil {
		t.Fatalf("expected fallback success, got %v", err)
	}
	if result.ParserName != "pdf" {
		t.Fatalf("expected fallback parser pdf, got %s", result.ParserName)
	}
	if result.ParsedDocument == nil {
		t.Fatalf("expected parsed document")
	}
	if got, _ := result.ParsedDocument.Metadata["fallbackReason"].(string); got != parsererrors.CodeBackendUnavailable {
		t.Fatalf("expected fallback reason parser-backend-unavailable, got %#v", result.ParsedDocument.Metadata["fallbackReason"])
	}
}

func TestAdapterFailsFromTikaWhenFallbackDisabled(t *testing.T) {
	adapter := &Adapter{
		config: Config{
			Provider:            ProviderTika,
			PDFEnabled:          true,
			DOCXEnabled:         true,
			TikaURL:             "http://localhost:9998",
			TikaFallbackEnabled: false,
		},
		text: mockParser{name: "text"},
		pdf:  mockParser{name: "pdf"},
		docx: mockParser{name: "docx"},
		tika: mockParser{name: "tika", err: parsererrors.BackendUnavailable("parser-tika", "offline", true, nil)},
	}

	_, err := adapter.Parse(context.Background(), ingestion.ParseRequest{
		DocumentID: "doc1",
		Source: ingestion.Source{
			Filename: "sample.pdf",
			MimeType: "application/pdf",
			URI:      "data:application/pdf;base64,ZmFrZS1wZGY=",
		},
	})
	if err == nil {
		t.Fatalf("expected error with fallback disabled")
	}

	type codeError interface {
		ErrorCode() string
	}
	var coded codeError
	if !errors.As(err, &coded) {
		t.Fatalf("expected coded parser error, got %T", err)
	}
	if coded.ErrorCode() != parsererrors.CodeBackendUnavailable {
		t.Fatalf("expected parser-backend-unavailable, got %s", coded.ErrorCode())
	}
}
