package pdfparser

import (
	"context"
	"errors"
	"testing"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

func TestParseReturnsDependencyMissingWhenBinaryUnavailable(t *testing.T) {
	originalLookup := lookupCommandPath
	lookupCommandPath = func(file string) (string, error) {
		return "", errors.New("not found")
	}
	t.Cleanup(func() {
		lookupCommandPath = originalLookup
	})

	adapter := NewAdapter()
	_, err := adapter.Parse(context.Background(), ingestion.ParseRequest{
		DocumentID: "doc-1",
		Source: ingestion.Source{
			Filename: "sample.pdf",
			MimeType: "application/pdf",
			URI:      "data:application/pdf;base64,JVBERi0xLjQ=",
		},
	})
	if err == nil {
		t.Fatalf("expected dependency-missing error")
	}

	type codeError interface {
		ErrorCode() string
	}
	var coded codeError
	if !errors.As(err, &coded) {
		t.Fatalf("expected coded parser error, got %T", err)
	}
	if coded.ErrorCode() != "dependency-missing" {
		t.Fatalf("expected dependency-missing code, got %s", coded.ErrorCode())
	}
}
