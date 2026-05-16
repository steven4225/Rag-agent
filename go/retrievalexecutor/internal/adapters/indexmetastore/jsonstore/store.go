package jsonstore

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	adapter "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexmetastore"
)

const (
	DefaultStorePath = "tmp/go-index-metadata-store.json"
	StoreType        = "json-file"
	SourceName       = "go-json-index-metadata-store"
)

type Store struct {
	mu   sync.Mutex
	path string
}

type filePayload struct {
	Version int                           `json:"version"`
	Records []adapter.IndexRecordMetadata `json:"records"`
}

func NewStore(path string) *Store {
	resolvedPath := strings.TrimSpace(path)
	if resolvedPath == "" {
		resolvedPath = DefaultStorePath
	}
	return &Store{path: resolvedPath}
}

func (s *Store) Upsert(_ context.Context, request adapter.UpsertRequest) (adapter.WriteResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	payload, err := s.load()
	if err != nil {
		return adapter.WriteResult{}, adapter.StoreError{
			Source:    SourceName,
			Operation: adapter.OperationUpsert,
			Retryable: true,
			Err:       err,
		}
	}

	nowText := time.Now().UTC().Format(time.RFC3339)
	byID := make(map[string]int, len(payload.Records))
	for i, record := range payload.Records {
		recordID := strings.TrimSpace(record.RecordID)
		if recordID == "" {
			continue
		}
		byID[recordID] = i
	}

	persistedRecordIDs := make([]string, 0, len(request.Records))
	for _, record := range request.Records {
		recordID := strings.TrimSpace(record.RecordID)
		if recordID == "" {
			continue
		}
		next := adapter.IndexRecordMetadata{
			RecordID:        recordID,
			KnowledgeBaseID: record.KnowledgeBaseID,
			DocumentID:      record.DocumentID,
			ChunkID:         record.ChunkID,
			ChunkIndex:      record.ChunkIndex,
			IndexName:       strings.TrimSpace(request.IndexName),
			EmbeddingRef:    record.EmbeddingRef,
			Source:          record.Source,
			Metadata:        cloneMap(record.Metadata),
			UpdatedAt:       nowText,
		}

		if index, exists := byID[recordID]; exists {
			payload.Records[index] = next
		} else {
			payload.Records = append(payload.Records, next)
			byID[recordID] = len(payload.Records) - 1
		}
		persistedRecordIDs = append(persistedRecordIDs, recordID)
	}

	if err := s.persist(payload); err != nil {
		return adapter.WriteResult{}, adapter.StoreError{
			Source:    SourceName,
			Operation: adapter.OperationUpsert,
			Retryable: true,
			Err:       err,
		}
	}

	return adapter.WriteResult{
		Source:              SourceName,
		StoreType:           StoreType,
		PersistedRecordIDs:  append([]string{}, persistedRecordIDs...),
		PersistedRecordSize: len(persistedRecordIDs),
		Metadata: map[string]any{
			"storePath":          s.path,
			"totalStoredRecords": len(payload.Records),
		},
	}, nil
}

func (s *Store) DeleteByDocument(_ context.Context, request adapter.DeleteByDocumentRequest) (adapter.DeleteResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	payload, err := s.load()
	if err != nil {
		return adapter.DeleteResult{}, adapter.StoreError{
			Source:    SourceName,
			Operation: adapter.OperationDeleteByDocument,
			Retryable: true,
			Err:       err,
		}
	}

	deleted := 0
	kept := make([]adapter.IndexRecordMetadata, 0, len(payload.Records))
	for _, record := range payload.Records {
		if record.KnowledgeBaseID == request.KnowledgeBaseID && record.DocumentID == request.DocumentID {
			deleted++
			continue
		}
		kept = append(kept, record)
	}
	payload.Records = kept

	if err := s.persist(payload); err != nil {
		return adapter.DeleteResult{}, adapter.StoreError{
			Source:    SourceName,
			Operation: adapter.OperationDeleteByDocument,
			Retryable: true,
			Err:       err,
		}
	}

	return adapter.DeleteResult{
		Source:             SourceName,
		StoreType:          StoreType,
		DeletedRecordCount: deleted,
		Metadata: map[string]any{
			"storePath":          s.path,
			"totalStoredRecords": len(payload.Records),
		},
	}, nil
}

func (s *Store) DeleteByKnowledgeBase(_ context.Context, request adapter.DeleteByKnowledgeBaseRequest) (adapter.DeleteResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	payload, err := s.load()
	if err != nil {
		return adapter.DeleteResult{}, adapter.StoreError{
			Source:    SourceName,
			Operation: adapter.OperationDeleteByKnowledgeBase,
			Retryable: true,
			Err:       err,
		}
	}

	deleted := 0
	kept := make([]adapter.IndexRecordMetadata, 0, len(payload.Records))
	for _, record := range payload.Records {
		if record.KnowledgeBaseID == request.KnowledgeBaseID {
			deleted++
			continue
		}
		kept = append(kept, record)
	}
	payload.Records = kept

	if err := s.persist(payload); err != nil {
		return adapter.DeleteResult{}, adapter.StoreError{
			Source:    SourceName,
			Operation: adapter.OperationDeleteByKnowledgeBase,
			Retryable: true,
			Err:       err,
		}
	}

	return adapter.DeleteResult{
		Source:             SourceName,
		StoreType:          StoreType,
		DeletedRecordCount: deleted,
		Metadata: map[string]any{
			"storePath":          s.path,
			"totalStoredRecords": len(payload.Records),
		},
	}, nil
}

func (s *Store) ListByDocument(_ context.Context, request adapter.ListByDocumentRequest) (adapter.ListResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	payload, err := s.load()
	if err != nil {
		return adapter.ListResult{}, adapter.StoreError{
			Source:    SourceName,
			Operation: adapter.OperationListByDocument,
			Retryable: true,
			Err:       err,
		}
	}

	records := make([]adapter.IndexRecordMetadata, 0, len(payload.Records))
	for _, record := range payload.Records {
		if record.KnowledgeBaseID != request.KnowledgeBaseID {
			continue
		}
		if record.DocumentID != request.DocumentID {
			continue
		}
		records = append(records, cloneRecord(record))
	}

	return adapter.ListResult{
		Source:    SourceName,
		StoreType: StoreType,
		Records:   records,
		Metadata: map[string]any{
			"storePath":       s.path,
			"filteredRecords": len(records),
			"totalRecords":    len(payload.Records),
		},
	}, nil
}

func (s *Store) load() (filePayload, error) {
	if _, err := os.Stat(s.path); err != nil {
		if os.IsNotExist(err) {
			return filePayload{
				Version: 1,
				Records: []adapter.IndexRecordMetadata{},
			}, nil
		}
		return filePayload{}, err
	}

	bytes, err := os.ReadFile(s.path)
	if err != nil {
		return filePayload{}, err
	}
	if len(bytes) == 0 {
		return filePayload{
			Version: 1,
			Records: []adapter.IndexRecordMetadata{},
		}, nil
	}

	var payload filePayload
	if err := json.Unmarshal(bytes, &payload); err != nil {
		return filePayload{}, fmt.Errorf("decode metadata store payload failed: %w", err)
	}
	if payload.Version <= 0 {
		payload.Version = 1
	}
	if payload.Records == nil {
		payload.Records = []adapter.IndexRecordMetadata{}
	}
	return payload, nil
}

func (s *Store) persist(payload filePayload) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	if payload.Version <= 0 {
		payload.Version = 1
	}

	bytes, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, bytes, 0o644)
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

func cloneRecord(record adapter.IndexRecordMetadata) adapter.IndexRecordMetadata {
	return adapter.IndexRecordMetadata{
		RecordID:        record.RecordID,
		KnowledgeBaseID: record.KnowledgeBaseID,
		DocumentID:      record.DocumentID,
		ChunkID:         record.ChunkID,
		ChunkIndex:      record.ChunkIndex,
		IndexName:       record.IndexName,
		EmbeddingRef:    record.EmbeddingRef,
		Source:          record.Source,
		Metadata:        cloneMap(record.Metadata),
		UpdatedAt:       record.UpdatedAt,
	}
}
