package indexstore

import (
	"context"
	"errors"
	"testing"

	indexmetastore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexmetastore"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

func TestMetadataPersistingAdapterUpsertPersistsMetadata(t *testing.T) {
	primary := &stubIndexAdapter{
		upsertResult: WriteResult{
			Status: ingestion.StatusSucceeded,
			Metadata: map[string]any{
				"persistedRecordIds": []string{"kb::chunk-1"},
			},
		},
	}
	metadata := &stubIndexMetadataAdapter{}
	adapter := NewMetadataPersistingAdapter(primary, metadata)

	_, err := adapter.Upsert(context.Background(), UpsertRequest{
		TraceID:         "trace-1",
		TaskID:          "task-1",
		KnowledgeBaseID: "kb",
		DocumentID:      "doc-1",
		Records: []ingestion.IndexRecord{
			{
				RecordID:        "kb::chunk-1",
				KnowledgeBaseID: "kb",
				DocumentID:      "doc-1",
				ChunkID:         "chunk-1",
			},
			{
				RecordID:        "kb::chunk-2",
				KnowledgeBaseID: "kb",
				DocumentID:      "doc-1",
				ChunkID:         "chunk-2",
			},
		},
	})
	if err != nil {
		t.Fatalf("expected upsert success, got %v", err)
	}
	if len(metadata.lastUpsertRequest.Records) != 1 {
		t.Fatalf("expected one persisted metadata record, got %d", len(metadata.lastUpsertRequest.Records))
	}
	if metadata.lastUpsertRequest.Records[0].RecordID != "kb::chunk-1" {
		t.Fatalf("expected persisted record kb::chunk-1, got %q", metadata.lastUpsertRequest.Records[0].RecordID)
	}
}

func TestMetadataPersistingAdapterUpsertReturnsWriteErrorOnMetadataFailure(t *testing.T) {
	primary := &stubIndexAdapter{
		upsertResult: WriteResult{
			Status:   ingestion.StatusSucceeded,
			Metadata: map[string]any{},
		},
	}
	metadata := &stubIndexMetadataAdapter{
		upsertErr: indexmetastore.StoreError{
			Source:    "meta-store",
			Operation: indexmetastore.OperationUpsert,
			Retryable: true,
			Err:       errors.New("disk unavailable"),
		},
	}
	adapter := NewMetadataPersistingAdapter(primary, metadata)

	_, err := adapter.Upsert(context.Background(), UpsertRequest{
		TraceID: "trace-1",
		Records: []ingestion.IndexRecord{
			{RecordID: "kb::chunk-1"},
		},
	})
	if err == nil {
		t.Fatalf("expected metadata persistence error")
	}
	writeErr, ok := IsWriteError(err)
	if !ok {
		t.Fatalf("expected WriteError, got %T", err)
	}
	if writeErr.ErrorSource() != "meta-store" {
		t.Fatalf("expected error source meta-store, got %q", writeErr.ErrorSource())
	}
}

func TestMetadataPersistingAdapterDeleteByDocumentPersistsMetadataDelete(t *testing.T) {
	primary := &stubIndexAdapter{
		deleteByDocumentResult: DeleteResult{Status: ingestion.StatusSucceeded},
	}
	metadata := &stubIndexMetadataAdapter{}
	adapter := NewMetadataPersistingAdapter(primary, metadata)

	_, err := adapter.DeleteByDocument(context.Background(), DeleteByDocumentRequest{
		TraceID:         "trace-1",
		KnowledgeBaseID: "kb",
		DocumentID:      "doc-1",
	})
	if err != nil {
		t.Fatalf("expected delete by document success, got %v", err)
	}
	if metadata.lastDeleteByDocumentRequest.KnowledgeBaseID != "kb" || metadata.lastDeleteByDocumentRequest.DocumentID != "doc-1" {
		t.Fatalf("expected metadata delete by document request to be forwarded, got %+v", metadata.lastDeleteByDocumentRequest)
	}
}

type stubIndexAdapter struct {
	upsertResult                WriteResult
	queryResult                 QueryResult
	deleteByDocumentResult      DeleteResult
	deleteByKnowledgeBaseResult DeleteResult
}

func (s *stubIndexAdapter) Upsert(_ context.Context, _ UpsertRequest) (WriteResult, error) {
	return s.upsertResult, nil
}

func (s *stubIndexAdapter) Query(_ context.Context, _ QueryRequest) (QueryResult, error) {
	return s.queryResult, nil
}

func (s *stubIndexAdapter) DeleteByDocument(_ context.Context, _ DeleteByDocumentRequest) (DeleteResult, error) {
	return s.deleteByDocumentResult, nil
}

func (s *stubIndexAdapter) DeleteByKnowledgeBase(_ context.Context, _ DeleteByKnowledgeBaseRequest) (DeleteResult, error) {
	return s.deleteByKnowledgeBaseResult, nil
}

type stubIndexMetadataAdapter struct {
	lastUpsertRequest                indexmetastore.UpsertRequest
	lastDeleteByDocumentRequest      indexmetastore.DeleteByDocumentRequest
	lastDeleteByKnowledgeBaseRequest indexmetastore.DeleteByKnowledgeBaseRequest
	upsertErr                        error
	deleteByDocumentErr              error
	deleteByKnowledgeBaseErr         error
}

func (s *stubIndexMetadataAdapter) Upsert(_ context.Context, request indexmetastore.UpsertRequest) (indexmetastore.WriteResult, error) {
	s.lastUpsertRequest = request
	if s.upsertErr != nil {
		return indexmetastore.WriteResult{}, s.upsertErr
	}
	return indexmetastore.WriteResult{
		Source:              "metadata",
		StoreType:           "stub",
		PersistedRecordIDs:  []string{"stub"},
		PersistedRecordSize: len(request.Records),
	}, nil
}

func (s *stubIndexMetadataAdapter) DeleteByDocument(_ context.Context, request indexmetastore.DeleteByDocumentRequest) (indexmetastore.DeleteResult, error) {
	s.lastDeleteByDocumentRequest = request
	if s.deleteByDocumentErr != nil {
		return indexmetastore.DeleteResult{}, s.deleteByDocumentErr
	}
	return indexmetastore.DeleteResult{Source: "metadata", StoreType: "stub"}, nil
}

func (s *stubIndexMetadataAdapter) DeleteByKnowledgeBase(_ context.Context, request indexmetastore.DeleteByKnowledgeBaseRequest) (indexmetastore.DeleteResult, error) {
	s.lastDeleteByKnowledgeBaseRequest = request
	if s.deleteByKnowledgeBaseErr != nil {
		return indexmetastore.DeleteResult{}, s.deleteByKnowledgeBaseErr
	}
	return indexmetastore.DeleteResult{Source: "metadata", StoreType: "stub"}, nil
}

func (s *stubIndexMetadataAdapter) ListByDocument(_ context.Context, _ indexmetastore.ListByDocumentRequest) (indexmetastore.ListResult, error) {
	return indexmetastore.ListResult{Source: "metadata", StoreType: "stub"}, nil
}
