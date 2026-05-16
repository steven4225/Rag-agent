package openai

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	provider "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/embedding/provider"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

func TestAdapterEmbedsWithOpenAICompatibleResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/embeddings" {
			t.Fatalf("expected /embeddings path, got %s", r.URL.Path)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer test-key" {
			t.Fatalf("expected bearer auth, got %q", auth)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
  "data": [
    {"index":0,"embedding":[0.1,0.2,0.3]},
    {"index":1,"embedding":[0.4,0.5,0.6]}
  ],
  "model":"text-embedding-3-small"
}`))
	}))
	defer server.Close()

	adapter, err := NewAdapter(Config{
		BaseURL: server.URL,
		APIKey:  "test-key",
		Model:   "text-embedding-3-small",
		Timeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("expected adapter creation success, got %v", err)
	}

	result, err := adapter.Embed(context.Background(), ingestion.EmbeddingRequest{
		Inputs: []ingestion.EmbeddingInput{
			{ChunkID: "chunk-1", DocumentID: "doc-1", ChunkIndex: 0, Text: "hello", CharCount: 5, ContentHash: "h1"},
			{ChunkID: "chunk-2", DocumentID: "doc-1", ChunkIndex: 1, Text: "world", CharCount: 5, ContentHash: "h2"},
		},
	})
	if err != nil {
		t.Fatalf("expected embedding success, got %v", err)
	}
	if result.Dimensions != 3 {
		t.Fatalf("expected dimensions=3, got %d", result.Dimensions)
	}
	if result.VectorCount != 2 {
		t.Fatalf("expected vectorCount=2, got %d", result.VectorCount)
	}
	if providerName, _ := result.Metadata["embeddingProvider"].(string); providerName != ProviderName {
		t.Fatalf("expected embeddingProvider=%q, got %#v", ProviderName, result.Metadata["embeddingProvider"])
	}
}

func TestAdapterReturnsRetryableErrorOn429(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"message":"rate limited"}}`))
	}))
	defer server.Close()

	adapter, err := NewAdapter(Config{
		BaseURL: server.URL,
		APIKey:  "test-key",
		Model:   "text-embedding-3-small",
	})
	if err != nil {
		t.Fatalf("expected adapter creation success, got %v", err)
	}

	_, err = adapter.Embed(context.Background(), ingestion.EmbeddingRequest{
		Inputs: []ingestion.EmbeddingInput{
			{ChunkID: "chunk-1", DocumentID: "doc-1", ChunkIndex: 0, Text: "hello", CharCount: 5, ContentHash: "h1"},
		},
	})
	if err == nil {
		t.Fatalf("expected retryable error")
	}
	var adapterErr provider.AdapterError
	if !errors.As(err, &adapterErr) {
		t.Fatalf("expected provider.AdapterError, got %T", err)
	}
	if !adapterErr.Retryable {
		t.Fatalf("expected retryable=true for 429")
	}
	if adapterErr.Reason != "provider-http-error" {
		t.Fatalf("expected provider-http-error, got %q", adapterErr.Reason)
	}
}
