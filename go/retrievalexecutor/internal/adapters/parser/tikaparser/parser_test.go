package tikaparser

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	parsererrors "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/parsererrors"
	parsersource "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/source"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

func TestParseExtractsTextAndMetadata(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPut {
			t.Fatalf("expected PUT method, got %s", request.Method)
		}
		switch request.URL.Path {
		case "/tika":
			if got := request.Header.Get("Accept"); got != "text/plain" {
				t.Fatalf("expected Accept text/plain, got %s", got)
			}
			_, _ = writer.Write([]byte("Hello from tika parser"))
		case "/meta":
			if got := request.Header.Get("Accept"); got != "application/json" {
				t.Fatalf("expected Accept application/json, got %s", got)
			}
			_, _ = writer.Write([]byte(`{"dc:title":"Policy Title","xmpTPg:NPages":"3","Author":"demo"}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	adapter := NewAdapter(Config{
		BaseURL: server.URL,
	})

	result, err := adapter.Parse(context.Background(), ingestion.ParseRequest{
		DocumentID: "doc-1",
		Source: ingestion.Source{
			Filename: "policy.pdf",
			MimeType: parsersource.KindPDF,
			URI:      "data:application/pdf;base64,ZmFrZS1wZGY=",
		},
		Plan: ingestion.ExecutionPlan{
			Parser: ingestion.ParserExecutionPlan{
				ParserType: "auto-parser",
				Mode:       "adapter",
			},
		},
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result.ParserBackend != "tika" {
		t.Fatalf("expected parser backend tika, got %s", result.ParserBackend)
	}
	if result.ParserName != "go-tika-parser" {
		t.Fatalf("expected parser name go-tika-parser, got %s", result.ParserName)
	}
	if result.ParsedDocument == nil {
		t.Fatalf("expected parsed document")
	}
	if result.ParsedDocument.CharCount <= 0 {
		t.Fatalf("expected positive char count")
	}
	if result.ParsedDocument.PageCount == nil || *result.ParsedDocument.PageCount != 3 {
		t.Fatalf("expected page count 3, got %#v", result.ParsedDocument.PageCount)
	}
	if result.ParsedDocument.Title != "Policy Title" {
		t.Fatalf("expected title from metadata, got %s", result.ParsedDocument.Title)
	}
	if metadataBackend, _ := result.ParsedDocument.Metadata["parserBackend"].(string); metadataBackend != "tika" {
		t.Fatalf("expected parsed document metadata parserBackend=tika, got %#v", result.ParsedDocument.Metadata["parserBackend"])
	}
}

func TestParseReturnsDependencyMissingWithoutURL(t *testing.T) {
	adapter := NewAdapter(Config{})
	_, err := adapter.Parse(context.Background(), ingestion.ParseRequest{
		DocumentID: "doc-1",
		Source: ingestion.Source{
			Filename: "policy.pdf",
			MimeType: parsersource.KindPDF,
			URI:      "data:application/pdf;base64,ZmFrZS1wZGY=",
		},
	})
	if err == nil {
		t.Fatalf("expected error when base url is not configured")
	}
	adapterErr, ok := err.(parsererrors.AdapterError)
	if !ok {
		t.Fatalf("expected parser adapter error, got %T", err)
	}
	if adapterErr.Code != parsererrors.CodeDependencyMissing {
		t.Fatalf("expected dependency-missing code, got %s", adapterErr.Code)
	}
}

func TestParseReturnsBackendUnavailableOnServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Error(writer, "tika unavailable", http.StatusServiceUnavailable)
	}))
	defer server.Close()

	adapter := NewAdapter(Config{
		BaseURL: server.URL,
	})
	_, err := adapter.Parse(context.Background(), ingestion.ParseRequest{
		DocumentID: "doc-1",
		Source: ingestion.Source{
			Filename: "policy.pdf",
			MimeType: parsersource.KindPDF,
			URI:      "data:application/pdf;base64,ZmFrZS1wZGY=",
		},
	})
	if err == nil {
		t.Fatalf("expected backend unavailable error")
	}
	adapterErr, ok := err.(parsererrors.AdapterError)
	if !ok {
		t.Fatalf("expected parser adapter error, got %T", err)
	}
	if adapterErr.Code != parsererrors.CodeBackendUnavailable {
		t.Fatalf("expected parser-backend-unavailable code, got %s", adapterErr.Code)
	}
	if !strings.Contains(adapterErr.Error(), "tika") {
		t.Fatalf("expected tika error message, got %s", adapterErr.Error())
	}
}
