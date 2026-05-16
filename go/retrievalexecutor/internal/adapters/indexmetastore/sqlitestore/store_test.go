package sqlitestore

import (
	"context"
	"path/filepath"
	"testing"

	adapter "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexmetastore"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

func TestStoreUpsertListAndDeleteByDocument(t *testing.T) {
	store, err := NewStore(Config{
		Path: filepath.Join(t.TempDir(), "index-metadata.db"),
	})
	if err != nil {
		t.Fatalf("init sqlite metadata store failed: %v", err)
	}
	defer store.Close()
	ctx := context.Background()

	_, err = store.Upsert(ctx, adapter.UpsertRequest{
		TraceID:         "trace-1",
		TaskID:          "task-1",
		KnowledgeBaseID: "kb",
		DocumentID:      "doc-1",
		IndexName:       "kb",
		Records: []ingestion.IndexRecord{
			{
				RecordID:        "kb::chunk-1",
				KnowledgeBaseID: "kb",
				DocumentID:      "doc-1",
				ChunkID:         "chunk-1",
				ChunkIndex:      0,
				EmbeddingRef:    "ref-1",
				Metadata: map[string]any{
					"section": "policy",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("expected upsert success, got %v", err)
	}

	listResult, err := store.ListByDocument(ctx, adapter.ListByDocumentRequest{
		TraceID:         "trace-2",
		KnowledgeBaseID: "kb",
		DocumentID:      "doc-1",
	})
	if err != nil {
		t.Fatalf("expected list success, got %v", err)
	}
	if len(listResult.Records) != 1 {
		t.Fatalf("expected one metadata record, got %d", len(listResult.Records))
	}
	if listResult.Records[0].Metadata["section"] != "policy" {
		t.Fatalf("expected metadata field section=policy, got %#v", listResult.Records[0].Metadata["section"])
	}

	deleteResult, err := store.DeleteByDocument(ctx, adapter.DeleteByDocumentRequest{
		TraceID:         "trace-3",
		KnowledgeBaseID: "kb",
		DocumentID:      "doc-1",
	})
	if err != nil {
		t.Fatalf("expected delete success, got %v", err)
	}
	if deleteResult.DeletedRecordCount != 1 {
		t.Fatalf("expected one deleted record, got %d", deleteResult.DeletedRecordCount)
	}
}
