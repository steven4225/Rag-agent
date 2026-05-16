package indexedsource

import (
	"context"
	"errors"
	"testing"

	indexstore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexstore"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/retrieval"
)

func TestSourceVectorModeUsesIndexVectors(t *testing.T) {
	source := NewSourceWithConfig(Config{
		Store: &stubStore{
			records: []ingestion.IndexRecord{
				{
					RecordID:        "kb::chunk-1",
					KnowledgeBaseID: "kb",
					DocumentID:      "doc-1",
					ChunkID:         "chunk-1",
					Title:           "ops runbook",
					Content:         "restart service",
					Vector:          []float32{1, 0},
					Metadata:        map[string]any{},
				},
				{
					RecordID:        "kb::chunk-2",
					KnowledgeBaseID: "kb",
					DocumentID:      "doc-1",
					ChunkID:         "chunk-2",
					Title:           "deployment guide",
					Content:         "blue green rollout",
					Vector:          []float32{0, 1},
					Metadata:        map[string]any{},
				},
			},
		},
		EmbeddingAdapter: stubEmbeddingAdapter{
			vector:   []float32{1, 0},
			provider: "deterministic",
			model:    "mock-embedding-v1",
		},
		RetrievalMode: retrieval.RetrievalModeVector,
	})

	result, err := source.Search(context.Background(), retrieval.SearchInput{
		TraceID:          "trace-vector",
		Query:            "restart",
		KnowledgeBaseIDs: []string{"kb"},
		TopK:             2,
	})
	if err != nil {
		t.Fatalf("expected vector search success, got %v", err)
	}
	if len(result.Chunks) == 0 {
		t.Fatalf("expected vector chunk candidates")
	}
	top := result.Chunks[0]
	if top.ChunkID != "chunk-1" {
		t.Fatalf("expected chunk-1 ranked first, got %q", top.ChunkID)
	}
	if top.Metadata["scoreSource"] != retrieval.ScoreSourceVector {
		t.Fatalf("expected scoreSource vector, got %#v", top.Metadata["scoreSource"])
	}
	if top.Metadata["retrievalMode"] != retrieval.RetrievalModeVector {
		t.Fatalf("expected retrievalMode vector, got %#v", top.Metadata["retrievalMode"])
	}
	if top.Metadata["queryEmbeddingProvider"] != "deterministic" {
		t.Fatalf("expected queryEmbeddingProvider metadata")
	}
	if top.Metadata["queryEmbeddingModel"] != "mock-embedding-v1" {
		t.Fatalf("expected queryEmbeddingModel metadata")
	}
}

func TestSourceHybridModeFallsBackToKeyword(t *testing.T) {
	source := NewSourceWithConfig(Config{
		Store: &stubStore{
			records: []ingestion.IndexRecord{
				{
					RecordID:        "kb::chunk-1",
					KnowledgeBaseID: "kb",
					DocumentID:      "doc-1",
					ChunkID:         "chunk-1",
					Title:           "incident runbook",
					Content:         "rollback checklist",
					Metadata:        map[string]any{},
				},
			},
		},
		EmbeddingAdapter: stubEmbeddingAdapter{
			vector:   []float32{1, 0},
			provider: "deterministic",
			model:    "mock-embedding-v1",
		},
		RetrievalMode: retrieval.RetrievalModeHybrid,
	})

	result, err := source.Search(context.Background(), retrieval.SearchInput{
		TraceID:          "trace-hybrid",
		Query:            "rollback checklist",
		KnowledgeBaseIDs: []string{"kb"},
		TopK:             1,
	})
	if err != nil {
		t.Fatalf("expected hybrid search success, got %v", err)
	}
	if len(result.Chunks) != 1 {
		t.Fatalf("expected one chunk, got %d", len(result.Chunks))
	}
	if result.Chunks[0].Metadata["scoreSource"] != retrieval.ScoreSourceKeyword {
		t.Fatalf("expected keyword fallback scoreSource, got %#v", result.Chunks[0].Metadata["scoreSource"])
	}
	if result.Chunks[0].Metadata["retrievalMode"] != retrieval.RetrievalModeHybrid {
		t.Fatalf("expected retrievalMode hybrid, got %#v", result.Chunks[0].Metadata["retrievalMode"])
	}
	if result.Chunks[0].Metadata["vectorFallbackReason"] == "" {
		t.Fatalf("expected vectorFallbackReason in hybrid fallback metadata")
	}
}

func TestSourceVectorModeReturnsErrorWhenNoVectorCandidates(t *testing.T) {
	source := NewSourceWithConfig(Config{
		Store: &stubStore{
			records: []ingestion.IndexRecord{
				{
					RecordID:        "kb::chunk-1",
					KnowledgeBaseID: "kb",
					DocumentID:      "doc-1",
					ChunkID:         "chunk-1",
					Title:           "incident runbook",
					Content:         "rollback checklist",
					Vector:          []float32{1, 0, 1},
					Metadata:        map[string]any{},
				},
			},
		},
		EmbeddingAdapter: stubEmbeddingAdapter{
			vector:   []float32{1, 0},
			provider: "deterministic",
			model:    "mock-embedding-v1",
		},
		RetrievalMode: retrieval.RetrievalModeVector,
	})

	_, err := source.Search(context.Background(), retrieval.SearchInput{
		TraceID:          "trace-vector-error",
		Query:            "rollback checklist",
		KnowledgeBaseIDs: []string{"kb"},
		TopK:             1,
	})
	if !errors.Is(err, ErrVectorCandidatesEmpty) {
		t.Fatalf("expected ErrVectorCandidatesEmpty, got %v", err)
	}
}

func TestSourcePassesVectorAndFiltersToIndexStoreQuery(t *testing.T) {
	store := &stubStore{
		records: []ingestion.IndexRecord{
			{
				RecordID:        "kb::chunk-1",
				KnowledgeBaseID: "kb",
				DocumentID:      "doc-1",
				ChunkID:         "chunk-1",
				Title:           "runbook",
				Content:         "rollback",
				Vector:          []float32{1, 0},
				Metadata:        map[string]any{"section": "ops"},
			},
		},
	}
	source := NewSourceWithConfig(Config{
		Store: store,
		EmbeddingAdapter: stubEmbeddingAdapter{
			vector:   []float32{1, 0},
			provider: "deterministic",
			model:    "mock-embedding-v1",
		},
		RetrievalMode: retrieval.RetrievalModeVector,
	})

	_, err := source.Search(context.Background(), retrieval.SearchInput{
		TraceID:          "trace-pass-through",
		Query:            "rollback",
		KnowledgeBaseIDs: []string{"kb"},
		TopK:             1,
		Filters: map[string]any{
			"documentId": "doc-1",
			"section":    "ops",
		},
	})
	if err != nil {
		t.Fatalf("expected vector search success, got %v", err)
	}
	if len(store.lastQueryRequest.QueryVector) != 2 {
		t.Fatalf("expected query vector passed to store query")
	}
	if store.lastQueryRequest.DocumentID != "doc-1" {
		t.Fatalf("expected documentId filter passed to store query")
	}
	if store.lastQueryRequest.TopK != 1 {
		t.Fatalf("expected topK passed to store query")
	}
}

type stubStore struct {
	records          []ingestion.IndexRecord
	lastQueryRequest indexstore.QueryRequest
}

func (s *stubStore) Upsert(_ context.Context, _ indexstore.UpsertRequest) (indexstore.WriteResult, error) {
	panic("not used in test")
}

func (s *stubStore) Query(_ context.Context, request indexstore.QueryRequest) (indexstore.QueryResult, error) {
	s.lastQueryRequest = request
	return indexstore.QueryResult{
		Source:  "stub",
		Records: s.records,
	}, nil
}

func (s *stubStore) DeleteByDocument(_ context.Context, _ indexstore.DeleteByDocumentRequest) (indexstore.DeleteResult, error) {
	panic("not used in test")
}

func (s *stubStore) DeleteByKnowledgeBase(_ context.Context, _ indexstore.DeleteByKnowledgeBaseRequest) (indexstore.DeleteResult, error) {
	panic("not used in test")
}

type stubEmbeddingAdapter struct {
	vector   []float32
	provider string
	model    string
}

func (a stubEmbeddingAdapter) Embed(_ context.Context, _ ingestion.EmbeddingRequest) (ingestion.EmbeddingResult, error) {
	return ingestion.EmbeddingResult{
		Status:     ingestion.StatusSucceeded,
		Model:      a.model,
		Source:     "stub",
		Dimensions: len(a.vector),
		Artifacts: []ingestion.EmbeddingArtifact{
			{
				ChunkID: "retrieval-query",
				Vector:  append([]float32{}, a.vector...),
			},
		},
		Metadata: map[string]any{
			"embeddingProvider": a.provider,
			"embeddingModel":    a.model,
		},
	}, nil
}
