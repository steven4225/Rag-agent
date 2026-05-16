package indexstore

import (
	"context"
	"errors"
	"fmt"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

const (
	OperationUpsert                = "upsert"
	OperationQuery                 = "query"
	OperationDeleteByDocument      = "delete-by-document"
	OperationDeleteByKnowledgeBase = "delete-by-knowledge-base"
)

type Adapter interface {
	Upsert(ctx context.Context, request UpsertRequest) (WriteResult, error)
	Query(ctx context.Context, request QueryRequest) (QueryResult, error)
	DeleteByDocument(ctx context.Context, request DeleteByDocumentRequest) (DeleteResult, error)
	DeleteByKnowledgeBase(ctx context.Context, request DeleteByKnowledgeBaseRequest) (DeleteResult, error)
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

type QueryRequest struct {
	TraceID          string
	KnowledgeBaseIDs []string
	DocumentID       string
	TenantID         string
	OrgID            string
	QueryVector      []float32
	SparseVector     map[string]float32
	TopK             int
	Filters          map[string]any
	Metadata         map[string]any
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

type WriteResult struct {
	Status              string
	IndexName           string
	StoreType           string
	Source              string
	Operation           string
	RecordCount         int
	IndexedChunkCount   int
	SkippedRecordCount  int
	ReplacedRecordCount int
	DeletedRecordCount  int
	Records             []ingestion.IndexRecord
	ErrorMessage        string
	Metadata            map[string]any
}

type QueryResult struct {
	Source   string
	Records  []ingestion.IndexRecord
	Metadata map[string]any
}

type DeleteResult struct {
	Status             string
	StoreType          string
	Source             string
	Operation          string
	DeletedRecordCount int
	Metadata           map[string]any
}

type ReadError struct {
	Source    string
	Operation string
	Retryable bool
	Err       error
}

func (e ReadError) Error() string {
	if e.Err == nil {
		return fmt.Sprintf("%s %s failed", e.Source, e.Operation)
	}
	return fmt.Sprintf("%s %s failed: %v", e.Source, e.Operation, e.Err)
}

func (e ReadError) Unwrap() error {
	return e.Err
}

func (e ReadError) ErrorSource() string {
	return e.Source
}

func (e ReadError) IsRetryable() bool {
	return e.Retryable
}

type WriteError struct {
	Source    string
	Operation string
	Retryable bool
	Err       error
}

func (e WriteError) Error() string {
	if e.Err == nil {
		return fmt.Sprintf("%s %s failed", e.Source, e.Operation)
	}
	return fmt.Sprintf("%s %s failed: %v", e.Source, e.Operation, e.Err)
}

func (e WriteError) Unwrap() error {
	return e.Err
}

func (e WriteError) ErrorSource() string {
	return e.Source
}

func (e WriteError) IsRetryable() bool {
	return e.Retryable
}

func IsReadError(err error) (ReadError, bool) {
	var target ReadError
	if errors.As(err, &target) {
		return target, true
	}
	return ReadError{}, false
}

func IsWriteError(err error) (WriteError, bool) {
	var target WriteError
	if errors.As(err, &target) {
		return target, true
	}
	return WriteError{}, false
}
