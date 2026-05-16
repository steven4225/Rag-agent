package jsonstore

import (
	"context"
	"path/filepath"
	"testing"

	adapter "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexstore"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

func TestStoreUpsertQueryAndDeleteByDocument(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "index.json"))
	ctx := context.Background()

	upsertResult, err := store.Upsert(ctx, adapter.UpsertRequest{
		TraceID:         "trace-1",
		TaskID:          "task-1",
		KnowledgeBaseID: "kb_policy",
		DocumentID:      "doc-1",
		IndexName:       "kb_policy",
		Operation:       adapter.OperationUpsert,
		IdempotencyKey:  "idem-1",
		Records: []ingestion.IndexRecord{
			{
				RecordID:        "kb_policy::chunk-1",
				KnowledgeBaseID: "kb_policy",
				DocumentID:      "doc-1",
				ChunkID:         "chunk-1",
				ChunkIndex:      0,
				Title:           "Policy",
				Content:         "first",
				Source:          "test",
				Vector:          []float32{1, 0},
				Metadata: map[string]any{
					"section": "policy",
				},
			},
			{
				RecordID:        "kb_policy::chunk-2",
				KnowledgeBaseID: "kb_policy",
				DocumentID:      "doc-1",
				ChunkID:         "chunk-2",
				ChunkIndex:      1,
				Title:           "Policy 2",
				Content:         "second",
				Source:          "test",
				Vector:          []float32{0, 1},
				Metadata: map[string]any{
					"section": "faq",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("expected upsert success, got %v", err)
	}
	if upsertResult.RecordCount != 2 || upsertResult.IndexedChunkCount != 2 {
		t.Fatalf("expected two written records, got %+v", upsertResult)
	}

	queryResult, err := store.Query(ctx, adapter.QueryRequest{
		TraceID:          "trace-2",
		KnowledgeBaseIDs: []string{"kb_policy"},
		QueryVector:      []float32{1, 0},
		TopK:             1,
		Filters: map[string]any{
			"section": "policy",
		},
	})
	if err != nil {
		t.Fatalf("expected query success, got %v", err)
	}
	if len(queryResult.Records) != 1 {
		t.Fatalf("expected one queried record, got %d", len(queryResult.Records))
	}
	if queryResult.Records[0].ChunkID != "chunk-1" {
		t.Fatalf("expected chunk-1 matched by vector and metadata filter, got %q", queryResult.Records[0].ChunkID)
	}

	deleteResult, err := store.DeleteByDocument(ctx, adapter.DeleteByDocumentRequest{
		TraceID:         "trace-3",
		KnowledgeBaseID: "kb_policy",
		DocumentID:      "doc-1",
	})
	if err != nil {
		t.Fatalf("expected delete success, got %v", err)
	}
	if deleteResult.DeletedRecordCount != 2 {
		t.Fatalf("expected two deleted records, got %d", deleteResult.DeletedRecordCount)
	}
}
