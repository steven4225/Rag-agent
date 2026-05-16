package indexmetastore

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

const (
	OperationUpsert                = "upsert"
	OperationDeleteByDocument      = "delete-by-document"
	OperationDeleteByKnowledgeBase = "delete-by-knowledge-base"
	OperationListByDocument        = "list-by-document"
)

type Adapter interface {
	Upsert(ctx context.Context, request UpsertRequest) (WriteResult, error)
	DeleteByDocument(ctx context.Context, request DeleteByDocumentRequest) (DeleteResult, error)
	DeleteByKnowledgeBase(ctx context.Context, request DeleteByKnowledgeBaseRequest) (DeleteResult, error)
	ListByDocument(ctx context.Context, request ListByDocumentRequest) (ListResult, error)
}

type UpsertRequest struct {
	TraceID         string
	TaskID          string
	KnowledgeBaseID string
	DocumentID      string
	IndexName       string
	Operation       string
	IdempotencyKey  string
	Records         []ingestion.IndexRecord
	Metadata        map[string]any
}

type DeleteByDocumentRequest struct {
	TraceID         string
	KnowledgeBaseID string
	DocumentID      string
	Metadata        map[string]any
}

type DeleteByKnowledgeBaseRequest struct {
	TraceID         string
	KnowledgeBaseID string
	Metadata        map[string]any
}

type ListByDocumentRequest struct {
	TraceID         string
	KnowledgeBaseID string
	DocumentID      string
}

type IndexRecordMetadata struct {
	RecordID        string
	KnowledgeBaseID string
	DocumentID      string
	ChunkID         string
	ChunkIndex      int
	IndexName       string
	EmbeddingRef    string
	Source          string
	Metadata        map[string]any
	UpdatedAt       string
}

type WriteResult struct {
	Source              string
	StoreType           string
	PersistedRecordIDs  []string
	PersistedRecordSize int
	Metadata            map[string]any
}

type DeleteResult struct {
	Source             string
	StoreType          string
	DeletedRecordCount int
	Metadata           map[string]any
}

type ListResult struct {
	Source    string
	StoreType string
	Records   []IndexRecordMetadata
	Metadata  map[string]any
}

type StoreError struct {
	Source    string
	Operation string
	Retryable bool
	Err       error
}

func (e StoreError) Error() string {
	if e.Err == nil {
		return fmt.Sprintf("%s %s failed", e.Source, e.Operation)
	}
	return fmt.Sprintf("%s %s failed: %v", e.Source, e.Operation, e.Err)
}

func (e StoreError) Unwrap() error {
	return e.Err
}

func (e StoreError) ErrorSource() string {
	return strings.TrimSpace(e.Source)
}

func (e StoreError) IsRetryable() bool {
	return e.Retryable
}

func IsStoreError(err error) (StoreError, bool) {
	var target StoreError
	if errors.As(err, &target) {
		return target, true
	}
	return StoreError{}, false
}
