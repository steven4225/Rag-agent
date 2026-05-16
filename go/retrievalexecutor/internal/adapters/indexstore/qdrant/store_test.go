package qdrant

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	adapter "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexstore"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

func TestStoreQueryUsesVectorEndpointAndFilter(t *testing.T) {
	t.Helper()

	searchCalled := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/collections":
			_, _ = w.Write([]byte(`{"status":"ok","result":{"collections":[]}}`))
			return
		case "/collections/ragent_chunks/points/search":
			searchCalled = true
			var req map[string]any
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatalf("decode query request failed: %v", err)
			}
			filter := req["filter"].(map[string]any)
			must := filter["must"].([]any)
			foundMetadataFilter := false
			for _, item := range must {
				next := item.(map[string]any)
				if next["key"] == "metadata.section" {
					foundMetadataFilter = true
				}
			}
			if !foundMetadataFilter {
				t.Fatalf("expected metadata.section filter in qdrant query")
			}
			_, _ = w.Write([]byte(`{"status":"ok","result":[{"id":1,"score":0.95,"payload":{"recordId":"kb::chunk-1","knowledgeBaseId":"kb","documentId":"doc-1","chunkId":"chunk-1","chunkIndex":0,"title":"Policy","content":"chunk content","embeddingRef":"ref-1","source":"test","metadata":{"section":"policy"}},"vector":[1,0]}]}`))
			return
		default:
			t.Fatalf("unexpected request path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	store, err := NewStore(Config{URL: server.URL, Collection: "ragent_chunks"})
	if err != nil {
		t.Fatalf("init store failed: %v", err)
	}

	result, err := store.Query(context.Background(), adapter.QueryRequest{
		TraceID:          "trace-1",
		KnowledgeBaseIDs: []string{"kb"},
		DocumentID:       "doc-1",
		QueryVector:      []float32{1, 0},
		TopK:             2,
		Filters: map[string]any{
			"section": "policy",
		},
	})
	if err != nil {
		t.Fatalf("query failed: %v", err)
	}
	if !searchCalled {
		t.Fatalf("expected search endpoint to be called")
	}
	if len(result.Records) != 1 {
		t.Fatalf("expected 1 result record, got %d", len(result.Records))
	}
	if result.Records[0].Metadata["_vectorScore"] == nil {
		t.Fatalf("expected _vectorScore metadata from qdrant hit")
	}
}

func TestStoreDeleteByDocumentCountsThenDeletes(t *testing.T) {
	t.Helper()

	countCalled := false
	deleteCalled := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/collections":
			_, _ = w.Write([]byte(`{"status":"ok","result":{"collections":[]}}`))
			return
		case "/collections/ragent_chunks/points/count":
			countCalled = true
			_, _ = w.Write([]byte(`{"status":"ok","result":{"count":3}}`))
			return
		case "/collections/ragent_chunks/points/delete":
			deleteCalled = true
			_, _ = w.Write([]byte(`{"status":"ok","result":{"status":"acknowledged"}}`))
			return
		default:
			t.Fatalf("unexpected request path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	store, err := NewStore(Config{URL: server.URL, Collection: "ragent_chunks"})
	if err != nil {
		t.Fatalf("init store failed: %v", err)
	}

	result, err := store.DeleteByDocument(context.Background(), adapter.DeleteByDocumentRequest{
		TraceID:         "trace-delete",
		KnowledgeBaseID: "kb",
		DocumentID:      "doc-1",
	})
	if err != nil {
		t.Fatalf("delete by document failed: %v", err)
	}
	if !countCalled || !deleteCalled {
		t.Fatalf("expected count and delete endpoints to be called")
	}
	if result.DeletedRecordCount != 3 {
		t.Fatalf("expected deleted count=3, got %d", result.DeletedRecordCount)
	}
}

func TestStoreContractIntegration(t *testing.T) {
	if !strings.EqualFold(strings.TrimSpace(os.Getenv("QDRANT_INTEGRATION_TEST")), "true") {
		t.Skip("set QDRANT_INTEGRATION_TEST=true to run")
	}

	qdrantURL := strings.TrimSpace(os.Getenv("QDRANT_URL"))
	if qdrantURL == "" {
		t.Skip("QDRANT_URL is required for integration test")
	}

	collection := "ragent_chunks_test_" + time.Now().UTC().Format("20060102150405")
	store, err := NewStore(Config{
		URL:        qdrantURL,
		APIKey:     strings.TrimSpace(os.Getenv("QDRANT_API_KEY")),
		Collection: collection,
		Timeout:    10 * time.Second,
	})
	if err != nil {
		t.Fatalf("init qdrant store failed: %v", err)
	}

	ctx := context.Background()
	_, err = store.Upsert(ctx, adapter.UpsertRequest{
		TraceID:         "trace-upsert",
		TaskID:          "task-1",
		KnowledgeBaseID: "kb_test",
		DocumentID:      "doc-1",
		IndexName:       collection,
		Operation:       adapter.OperationUpsert,
		IdempotencyKey:  "idem-1",
		Records: []ingestion.IndexRecord{
			{
				RecordID:        "kb_test::chunk-1",
				KnowledgeBaseID: "kb_test",
				DocumentID:      "doc-1",
				ChunkID:         "chunk-1",
				ChunkIndex:      0,
				Title:           "Policy",
				Content:         "safe rollout",
				EmbeddingRef:    "ref-1",
				Vector:          []float32{1, 0},
				Source:          "test",
				Metadata: map[string]any{
					"section": "policy",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("upsert failed: %v", err)
	}

	queryResult, err := store.Query(ctx, adapter.QueryRequest{
		TraceID:          "trace-query",
		KnowledgeBaseIDs: []string{"kb_test"},
		DocumentID:       "doc-1",
		QueryVector:      []float32{1, 0},
		TopK:             1,
		Filters: map[string]any{
			"section": "policy",
		},
	})
	if err != nil {
		t.Fatalf("query failed: %v", err)
	}
	if len(queryResult.Records) != 1 {
		t.Fatalf("expected one queried record, got %d", len(queryResult.Records))
	}

	deleteResult, err := store.DeleteByDocument(ctx, adapter.DeleteByDocumentRequest{
		TraceID:         "trace-delete",
		KnowledgeBaseID: "kb_test",
		DocumentID:      "doc-1",
	})
	if err != nil {
		t.Fatalf("delete failed: %v", err)
	}
	if deleteResult.DeletedRecordCount < 1 {
		t.Fatalf("expected deleted records >=1, got %d", deleteResult.DeletedRecordCount)
	}
}
