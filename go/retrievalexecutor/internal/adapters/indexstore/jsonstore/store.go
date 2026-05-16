package jsonstore

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	adapter "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexstore"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

const (
	DefaultIndexName = "local-placeholder-index"
	StoreType        = "json-file"
	SourceName       = "go-json-index-store"
)

type Store struct {
	mu   sync.RWMutex
	path string
}

type filePayload struct {
	Records []ingestion.IndexRecord `json:"records"`
}

func NewStore(path string) *Store {
	if path == "" {
		path = filepath.Join("tmp", "go-local-index-store.json")
	}
	return &Store{path: path}
}

func (s *Store) Upsert(_ context.Context, request adapter.UpsertRequest) (adapter.WriteResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	payload, err := s.load()
	if err != nil {
		return adapter.WriteResult{}, adapter.WriteError{
			Source:    SourceName,
			Operation: adapter.OperationUpsert,
			Retryable: true,
			Err:       err,
		}
	}

	existingByID := make(map[string]int, len(payload.Records))
	existingByFingerprint := make(map[string]int, len(payload.Records))
	for index, record := range payload.Records {
		if id := strings.TrimSpace(record.RecordID); id != "" {
			existingByID[id] = index
		}
		existingByFingerprint[fingerprint(record)] = index
	}

	replacedCount := 0
	skippedCount := 0
	indexedCount := 0
	for _, record := range cloneRecords(request.Records) {
		recordID := strings.TrimSpace(record.RecordID)
		if recordID != "" {
			if existingIndex, ok := existingByID[recordID]; ok {
				if recordsEqual(payload.Records[existingIndex], record) {
					skippedCount++
					continue
				}
				payload.Records[existingIndex] = record
				replacedCount++
				indexedCount++
				existingByFingerprint[fingerprint(record)] = existingIndex
				continue
			}
			payload.Records = append(payload.Records, record)
			nextIndex := len(payload.Records) - 1
			existingByID[recordID] = nextIndex
			existingByFingerprint[fingerprint(record)] = nextIndex
			indexedCount++
			continue
		}

		fingerprintValue := fingerprint(record)
		if existingIndex, ok := existingByFingerprint[fingerprintValue]; ok {
			if recordsEqual(payload.Records[existingIndex], record) {
				skippedCount++
				continue
			}
			payload.Records[existingIndex] = record
			replacedCount++
			indexedCount++
			continue
		}
		payload.Records = append(payload.Records, record)
		existingByFingerprint[fingerprintValue] = len(payload.Records) - 1
		indexedCount++
	}

	if err := s.persist(payload); err != nil {
		return adapter.WriteResult{}, adapter.WriteError{
			Source:    SourceName,
			Operation: adapter.OperationUpsert,
			Retryable: true,
			Err:       err,
		}
	}

	indexName := request.IndexName
	if indexName == "" {
		indexName = DefaultIndexName
	}

	return adapter.WriteResult{
		Status:              ingestion.StatusSucceeded,
		IndexName:           indexName,
		StoreType:           StoreType,
		Source:              SourceName,
		Operation:           adapter.OperationUpsert,
		RecordCount:         len(request.Records),
		IndexedChunkCount:   indexedCount,
		SkippedRecordCount:  skippedCount,
		ReplacedRecordCount: replacedCount,
		DeletedRecordCount:  0,
		Records:             cloneRecords(request.Records),
		Metadata: map[string]any{
			"storePath":          s.path,
			"totalStoredRecords": len(payload.Records),
			"placeholder":        true,
			"idempotencyKey":     request.IdempotencyKey,
			"persistedRecordIds": extractRecordIDs(request.Records),
		},
	}, nil
}

func (s *Store) Query(_ context.Context, request adapter.QueryRequest) (adapter.QueryResult, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	payload, err := s.load()
	if err != nil {
		return adapter.QueryResult{}, adapter.ReadError{
			Source:    SourceName,
			Operation: adapter.OperationQuery,
			Retryable: true,
			Err:       err,
		}
	}

	type scoredRecord struct {
		record ingestion.IndexRecord
		score  float64
	}
	filtered := make([]scoredRecord, 0, len(payload.Records))
	for _, record := range payload.Records {
		if tenantID := strings.TrimSpace(request.TenantID); tenantID != "" && tenantID != record.TenantID {
			continue
		}
		if orgID := strings.TrimSpace(request.OrgID); orgID != "" && orgID != record.OrgID {
			continue
		}
		if len(request.KnowledgeBaseIDs) > 0 && !contains(request.KnowledgeBaseIDs, record.KnowledgeBaseID) {
			continue
		}
		if strings.TrimSpace(request.DocumentID) != "" && request.DocumentID != record.DocumentID {
			continue
		}
		matched, err := matchesMetadataFilters(record, request.Filters)
		if err != nil {
			return adapter.QueryResult{}, adapter.ReadError{
				Source:    SourceName,
				Operation: adapter.OperationQuery,
				Retryable: false,
				Err:       err,
			}
		}
		if !matched {
			continue
		}

		recordScore := 0.0
		if len(request.QueryVector) > 0 {
			if len(record.Vector) == 0 || len(record.Vector) != len(request.QueryVector) {
				continue
			}
			score, scoreErr := cosineSimilarity(request.QueryVector, record.Vector)
			if scoreErr != nil {
				continue
			}
			if score <= 0 {
				continue
			}
			recordScore = score
		}

		next := cloneRecords([]ingestion.IndexRecord{record})[0]
		next.Metadata["_indexBackend"] = "json"
		next.Metadata["_indexStoreSource"] = SourceName
		next.Metadata["_indexStoreType"] = StoreType
		if len(request.QueryVector) > 0 {
			next.Metadata["_vectorScore"] = recordScore
		}
		filtered = append(filtered, scoredRecord{record: next, score: recordScore})
	}

	if len(request.QueryVector) > 0 {
		sort.SliceStable(filtered, func(i, j int) bool {
			if filtered[i].score == filtered[j].score {
				return filtered[i].record.RecordID < filtered[j].record.RecordID
			}
			return filtered[i].score > filtered[j].score
		})
	}

	if request.TopK > 0 && len(filtered) > request.TopK {
		filtered = filtered[:request.TopK]
	}

	records := make([]ingestion.IndexRecord, 0, len(filtered))
	for _, item := range filtered {
		records = append(records, item.record)
	}

	return adapter.QueryResult{
		Source:  SourceName,
		Records: records,
		Metadata: map[string]any{
			"storePath":       s.path,
			"filteredRecords": len(records),
			"totalRecords":    len(payload.Records),
		},
	}, nil
}

func (s *Store) DeleteByDocument(_ context.Context, request adapter.DeleteByDocumentRequest) (adapter.DeleteResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	payload, err := s.load()
	if err != nil {
		return adapter.DeleteResult{}, adapter.WriteError{
			Source:    SourceName,
			Operation: adapter.OperationDeleteByDocument,
			Retryable: true,
			Err:       err,
		}
	}

	deleted := 0
	kept := make([]ingestion.IndexRecord, 0, len(payload.Records))
	for _, record := range payload.Records {
		if record.KnowledgeBaseID == request.KnowledgeBaseID && record.DocumentID == request.DocumentID {
			deleted++
			continue
		}
		kept = append(kept, record)
	}
	payload.Records = kept

	if err := s.persist(payload); err != nil {
		return adapter.DeleteResult{}, adapter.WriteError{
			Source:    SourceName,
			Operation: adapter.OperationDeleteByDocument,
			Retryable: true,
			Err:       err,
		}
	}

	return adapter.DeleteResult{
		Status:             ingestion.StatusSucceeded,
		StoreType:          StoreType,
		Source:             SourceName,
		Operation:          adapter.OperationDeleteByDocument,
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
		return adapter.DeleteResult{}, adapter.WriteError{
			Source:    SourceName,
			Operation: adapter.OperationDeleteByKnowledgeBase,
			Retryable: true,
			Err:       err,
		}
	}

	deleted := 0
	kept := make([]ingestion.IndexRecord, 0, len(payload.Records))
	for _, record := range payload.Records {
		if record.KnowledgeBaseID == request.KnowledgeBaseID {
			deleted++
			continue
		}
		kept = append(kept, record)
	}
	payload.Records = kept

	if err := s.persist(payload); err != nil {
		return adapter.DeleteResult{}, adapter.WriteError{
			Source:    SourceName,
			Operation: adapter.OperationDeleteByKnowledgeBase,
			Retryable: true,
			Err:       err,
		}
	}

	return adapter.DeleteResult{
		Status:             ingestion.StatusSucceeded,
		StoreType:          StoreType,
		Source:             SourceName,
		Operation:          adapter.OperationDeleteByKnowledgeBase,
		DeletedRecordCount: deleted,
		Metadata: map[string]any{
			"storePath":          s.path,
			"totalStoredRecords": len(payload.Records),
		},
	}, nil
}

func (s *Store) load() (filePayload, error) {
	if _, err := os.Stat(s.path); err != nil {
		if os.IsNotExist(err) {
			return filePayload{Records: []ingestion.IndexRecord{}}, nil
		}
		return filePayload{}, err
	}

	bytes, err := os.ReadFile(s.path)
	if err != nil {
		return filePayload{}, err
	}
	if len(bytes) == 0 {
		return filePayload{Records: []ingestion.IndexRecord{}}, nil
	}

	var payload filePayload
	if err := json.Unmarshal(bytes, &payload); err != nil {
		return filePayload{}, err
	}
	if payload.Records == nil {
		payload.Records = []ingestion.IndexRecord{}
	}
	return payload, nil
}

func (s *Store) persist(payload filePayload) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}

	bytes, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, bytes, 0o644)
}

func cloneRecords(records []ingestion.IndexRecord) []ingestion.IndexRecord {
	cloned := make([]ingestion.IndexRecord, 0, len(records))
	for _, record := range records {
		next := ingestion.IndexRecord{
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
			Metadata:        map[string]any{},
		}
		for key, value := range record.Metadata {
			next.Metadata[key] = value
		}
		cloned = append(cloned, next)
	}
	return cloned
}

func extractRecordIDs(records []ingestion.IndexRecord) []string {
	ids := make([]string, 0, len(records))
	for _, record := range records {
		recordID := strings.TrimSpace(record.RecordID)
		if recordID == "" {
			continue
		}
		ids = append(ids, recordID)
	}
	return ids
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func fingerprint(record ingestion.IndexRecord) string {
	return strings.Join([]string{
		record.KnowledgeBaseID,
		record.DocumentID,
		record.ChunkID,
		record.Title,
	}, "::")
}

func recordsEqual(left ingestion.IndexRecord, right ingestion.IndexRecord) bool {
	if left.RecordID != right.RecordID ||
		left.KnowledgeBaseID != right.KnowledgeBaseID ||
		left.DocumentID != right.DocumentID ||
		left.ChunkID != right.ChunkID ||
		left.ChunkIndex != right.ChunkIndex ||
		left.Title != right.Title ||
		left.Content != right.Content ||
		left.EmbeddingRef != right.EmbeddingRef ||
		left.Source != right.Source {
		return false
	}

	if len(left.Vector) != len(right.Vector) {
		return false
	}
	for i := range left.Vector {
		if left.Vector[i] != right.Vector[i] {
			return false
		}
	}

	return metadataEqual(left.Metadata, right.Metadata)
}

func metadataEqual(left map[string]any, right map[string]any) bool {
	leftBytes, leftErr := json.Marshal(left)
	rightBytes, rightErr := json.Marshal(right)
	if leftErr != nil || rightErr != nil {
		return false
	}
	return string(leftBytes) == string(rightBytes)
}

func matchesMetadataFilters(record ingestion.IndexRecord, filters map[string]any) (bool, error) {
	if len(filters) == 0 {
		return true, nil
	}
	for key, raw := range filters {
		switch key {
		case "knowledgeBaseId":
			expected := strings.TrimSpace(fmt.Sprint(raw))
			if expected != "" && record.KnowledgeBaseID != expected {
				return false, nil
			}
		case "documentId":
			expected := strings.TrimSpace(fmt.Sprint(raw))
			if expected != "" && record.DocumentID != expected {
				return false, nil
			}
		default:
			actual, exists := record.Metadata[key]
			if !exists {
				return false, nil
			}
			if !strings.EqualFold(strings.TrimSpace(fmt.Sprint(actual)), strings.TrimSpace(fmt.Sprint(raw))) {
				return false, nil
			}
		}
	}
	return true, nil
}

func cosineSimilarity(left []float32, right []float32) (float64, error) {
	if len(left) == 0 || len(right) == 0 || len(left) != len(right) {
		return 0, fmt.Errorf("vector dimensions mismatch: left=%d right=%d", len(left), len(right))
	}

	var dot float64
	var leftNorm float64
	var rightNorm float64
	for i := range left {
		l := float64(left[i])
		r := float64(right[i])
		dot += l * r
		leftNorm += l * l
		rightNorm += r * r
	}
	if leftNorm == 0 || rightNorm == 0 {
		return 0, fmt.Errorf("zero-norm vector")
	}
	return dot / (math.Sqrt(leftNorm) * math.Sqrt(rightNorm)), nil
}
