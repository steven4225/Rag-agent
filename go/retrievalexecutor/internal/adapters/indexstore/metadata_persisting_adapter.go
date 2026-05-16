package indexstore

import (
	"context"
	"fmt"
	"strings"

	indexmetastore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexmetastore"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

type metadataPersistingAdapter struct {
	primary  Adapter
	metadata indexmetastore.Adapter
}

func NewMetadataPersistingAdapter(primary Adapter, metadata indexmetastore.Adapter) Adapter {
	if primary == nil || metadata == nil {
		return primary
	}
	return &metadataPersistingAdapter{
		primary:  primary,
		metadata: metadata,
	}
}

func (a *metadataPersistingAdapter) Upsert(ctx context.Context, request UpsertRequest) (WriteResult, error) {
	result, err := a.primary.Upsert(ctx, request)
	if err != nil {
		return WriteResult{}, err
	}

	persistedRecords := resolvePersistedRecords(request.Records, result.Metadata)
	metaResult, err := a.metadata.Upsert(ctx, indexmetastore.UpsertRequest{
		TraceID:         request.TraceID,
		TaskID:          request.TaskID,
		KnowledgeBaseID: request.KnowledgeBaseID,
		DocumentID:      request.DocumentID,
		IndexName:       request.IndexName,
		Operation:       request.Operation,
		IdempotencyKey:  request.IdempotencyKey,
		Records:         persistedRecords,
		Metadata:        cloneMap(request.Metadata),
	})
	if err != nil {
		return WriteResult{}, toWriteError(OperationUpsert, err)
	}

	result.Metadata = mergeMaps(result.Metadata, map[string]any{
		"indexMetadataStoreSource":     metaResult.Source,
		"indexMetadataStoreType":       metaResult.StoreType,
		"indexMetadataPersistedCount":  metaResult.PersistedRecordSize,
		"indexMetadataPersistedRecord": append([]string{}, metaResult.PersistedRecordIDs...),
	})
	return result, nil
}

func (a *metadataPersistingAdapter) Query(ctx context.Context, request QueryRequest) (QueryResult, error) {
	return a.primary.Query(ctx, request)
}

func (a *metadataPersistingAdapter) DeleteByDocument(ctx context.Context, request DeleteByDocumentRequest) (DeleteResult, error) {
	result, err := a.primary.DeleteByDocument(ctx, request)
	if err != nil {
		return DeleteResult{}, err
	}

	metaResult, err := a.metadata.DeleteByDocument(ctx, indexmetastore.DeleteByDocumentRequest{
		TraceID:         request.TraceID,
		KnowledgeBaseID: request.KnowledgeBaseID,
		DocumentID:      request.DocumentID,
		Metadata:        cloneMap(request.Metadata),
	})
	if err != nil {
		return DeleteResult{}, toWriteError(OperationDeleteByDocument, err)
	}

	result.Metadata = mergeMaps(result.Metadata, map[string]any{
		"indexMetadataStoreSource":    metaResult.Source,
		"indexMetadataStoreType":      metaResult.StoreType,
		"indexMetadataDeletedRecords": metaResult.DeletedRecordCount,
	})
	return result, nil
}

func (a *metadataPersistingAdapter) DeleteByKnowledgeBase(ctx context.Context, request DeleteByKnowledgeBaseRequest) (DeleteResult, error) {
	result, err := a.primary.DeleteByKnowledgeBase(ctx, request)
	if err != nil {
		return DeleteResult{}, err
	}

	metaResult, err := a.metadata.DeleteByKnowledgeBase(ctx, indexmetastore.DeleteByKnowledgeBaseRequest{
		TraceID:         request.TraceID,
		KnowledgeBaseID: request.KnowledgeBaseID,
		Metadata:        cloneMap(request.Metadata),
	})
	if err != nil {
		return DeleteResult{}, toWriteError(OperationDeleteByKnowledgeBase, err)
	}

	result.Metadata = mergeMaps(result.Metadata, map[string]any{
		"indexMetadataStoreSource":    metaResult.Source,
		"indexMetadataStoreType":      metaResult.StoreType,
		"indexMetadataDeletedRecords": metaResult.DeletedRecordCount,
	})
	return result, nil
}

func resolvePersistedRecords(records []ingestion.IndexRecord, metadata map[string]any) []ingestion.IndexRecord {
	if len(records) == 0 {
		return []ingestion.IndexRecord{}
	}

	recordIDs := extractStringSlice(metadata, "persistedRecordIds")
	if len(recordIDs) == 0 {
		return cloneRecords(records)
	}
	allowed := make(map[string]struct{}, len(recordIDs))
	for _, recordID := range recordIDs {
		allowed[strings.TrimSpace(recordID)] = struct{}{}
	}

	filtered := make([]ingestion.IndexRecord, 0, len(recordIDs))
	for _, record := range records {
		recordID := strings.TrimSpace(record.RecordID)
		if _, ok := allowed[recordID]; !ok {
			continue
		}
		filtered = append(filtered, cloneRecord(record))
	}
	return filtered
}

func extractStringSlice(source map[string]any, key string) []string {
	if len(source) == 0 {
		return nil
	}
	value, ok := source[key]
	if !ok {
		return nil
	}
	switch typed := value.(type) {
	case []string:
		result := make([]string, 0, len(typed))
		for _, text := range typed {
			if trimmed := strings.TrimSpace(text); trimmed != "" {
				result = append(result, trimmed)
			}
		}
		return result
	case []any:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			text := strings.TrimSpace(fmt.Sprint(item))
			if text != "" && text != "<nil>" {
				result = append(result, text)
			}
		}
		return result
	default:
		return nil
	}
}

func toWriteError(operation string, err error) error {
	if storeErr, ok := indexmetastore.IsStoreError(err); ok {
		return WriteError{
			Source:    storeErr.ErrorSource(),
			Operation: operation,
			Retryable: storeErr.IsRetryable(),
			Err:       storeErr,
		}
	}
	return WriteError{
		Source:    "index-metadata-store",
		Operation: operation,
		Retryable: true,
		Err:       err,
	}
}

func mergeMaps(base map[string]any, extra map[string]any) map[string]any {
	merged := cloneMap(base)
	for key, value := range extra {
		merged[key] = value
	}
	return merged
}

func cloneMap(source map[string]any) map[string]any {
	if len(source) == 0 {
		return map[string]any{}
	}
	cloned := make(map[string]any, len(source))
	for key, value := range source {
		cloned[key] = value
	}
	return cloned
}

func cloneRecords(records []ingestion.IndexRecord) []ingestion.IndexRecord {
	cloned := make([]ingestion.IndexRecord, 0, len(records))
	for _, record := range records {
		cloned = append(cloned, cloneRecord(record))
	}
	return cloned
}

func cloneRecord(record ingestion.IndexRecord) ingestion.IndexRecord {
	return ingestion.IndexRecord{
		RecordID:        record.RecordID,
		KnowledgeBaseID: record.KnowledgeBaseID,
		DocumentID:      record.DocumentID,
		ChunkID:         record.ChunkID,
		ChunkIndex:      record.ChunkIndex,
		Title:           record.Title,
		Content:         record.Content,
		EmbeddingRef:    record.EmbeddingRef,
		Vector:          append([]float32{}, record.Vector...),
		Source:          record.Source,
		Metadata:        cloneMap(record.Metadata),
	}
}
