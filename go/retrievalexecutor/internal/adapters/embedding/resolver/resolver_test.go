package resolver

import (
	"context"
	"errors"
	"testing"

	provider "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/embedding/provider"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

func TestResolveDefaultsToDeterministic(t *testing.T) {
	adapter := Resolve(Config{})
	result, err := adapter.Embed(context.Background(), ingestion.EmbeddingRequest{
		Inputs: []ingestion.EmbeddingInput{
			{
				ChunkID:     "chunk-1",
				DocumentID:  "doc-1",
				ChunkIndex:  0,
				Text:        "hello",
				CharCount:   5,
				ContentHash: "hash-1",
			},
		},
	})
	if err != nil {
		t.Fatalf("expected deterministic embedding success, got %v", err)
	}
	if providerName, _ := result.Metadata["embeddingProvider"].(string); providerName != ProviderDeterministic {
		t.Fatalf("expected deterministic provider metadata, got %#v", result.Metadata["embeddingProvider"])
	}
}

func TestResolveFallsBackWhenProviderUnsupported(t *testing.T) {
	adapter := Resolve(Config{
		Provider:        "mock-provider-name",
		Model:           "mock-model",
		FallbackEnabled: true,
	})
	result, err := adapter.Embed(context.Background(), ingestion.EmbeddingRequest{
		Inputs: []ingestion.EmbeddingInput{
			{
				ChunkID:     "chunk-1",
				DocumentID:  "doc-1",
				ChunkIndex:  0,
				Text:        "hello",
				CharCount:   5,
				ContentHash: "hash-1",
			},
		},
	})
	if err != nil {
		t.Fatalf("expected fallback success, got %v", err)
	}
	if fallbackReason, _ := result.Metadata["fallbackReason"].(string); fallbackReason != "provider-unsupported" {
		t.Fatalf("expected provider-unsupported fallbackReason, got %#v", result.Metadata["fallbackReason"])
	}
}

func TestResolveFailsWhenProviderUnsupportedAndFallbackDisabled(t *testing.T) {
	adapter := Resolve(Config{
		Provider:        "mock-provider-name",
		Model:           "mock-model",
		FallbackEnabled: false,
	})
	_, err := adapter.Embed(context.Background(), ingestion.EmbeddingRequest{
		Inputs: []ingestion.EmbeddingInput{
			{
				ChunkID:     "chunk-1",
				DocumentID:  "doc-1",
				ChunkIndex:  0,
				Text:        "hello",
				CharCount:   5,
				ContentHash: "hash-1",
			},
		},
	})
	if err == nil {
		t.Fatalf("expected resolver failure with fallback disabled")
	}
	var adapterErr provider.AdapterError
	if !errors.As(err, &adapterErr) {
		t.Fatalf("expected provider.AdapterError, got %T", err)
	}
	if adapterErr.Reason != "provider-unsupported" {
		t.Fatalf("expected provider-unsupported reason, got %q", adapterErr.Reason)
	}
}
