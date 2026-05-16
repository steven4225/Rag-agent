package qdrant

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	adapter "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexstore"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/retrieval/keywordsearcher"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

const (
	StoreType  = "qdrant"
	SourceName = "go-qdrant-index-store"
)

type Config struct {
	URL        string
	APIKey     string
	Collection string
	Timeout    time.Duration
}

type Store struct {
	baseURL    string
	apiKey     string
	collection string
	client     *http.Client

	mu                 sync.Mutex
	collectionReady    bool
	collectionVectorSz int
}

func NewStore(config Config) (*Store, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(config.URL), "/")
	if baseURL == "" {
		return nil, fmt.Errorf("QDRANT_URL is required when INDEX_BACKEND=qdrant")
	}
	if _, err := url.ParseRequestURI(baseURL); err != nil {
		return nil, fmt.Errorf("invalid QDRANT_URL: %w", err)
	}

	collection := strings.TrimSpace(config.Collection)
	if collection == "" {
		collection = "ragent_chunks"
	}

	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}

	store := &Store{
		baseURL:    baseURL,
		apiKey:     strings.TrimSpace(config.APIKey),
		collection: collection,
		client:     &http.Client{Timeout: timeout},
	}
	if err := store.ping(context.Background()); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *Store) Upsert(ctx context.Context, request adapter.UpsertRequest) (adapter.WriteResult, error) {
	vectorSize, points, skipped, persistedRecordIDs, skippedRecordIDs := s.toPoints(request.Records)
	if len(points) == 0 {
		return adapter.WriteResult{
			Status:             ingestion.StatusSucceeded,
			IndexName:          request.IndexName,
			StoreType:          StoreType,
			Source:             SourceName,
			Operation:          adapter.OperationUpsert,
			RecordCount:        len(request.Records),
			IndexedChunkCount:  0,
			SkippedRecordCount: skipped,
			Metadata: map[string]any{
				"collection":         s.collection,
				"qdrantURL":          s.baseURL,
				"idempotencyKey":     request.IdempotencyKey,
				"skippedNoVector":    skipped,
				"persistedRecordIds": persistedRecordIDs,
				"skippedRecordIds":   skippedRecordIDs,
			},
		}, nil
	}

	if err := s.ensureCollection(ctx, vectorSize); err != nil {
		return adapter.WriteResult{}, adapter.WriteError{
			Source:    SourceName,
			Operation: adapter.OperationUpsert,
			Retryable: isRetryableError(err),
			Err:       err,
		}
	}

	if err := s.upsertPoints(ctx, points); err != nil {
		return adapter.WriteResult{}, adapter.WriteError{
			Source:    SourceName,
			Operation: adapter.OperationUpsert,
			Retryable: isRetryableError(err),
			Err:       err,
		}
	}

	indexName := strings.TrimSpace(request.IndexName)
	if indexName == "" {
		indexName = s.collection
	}

	return adapter.WriteResult{
		Status:             ingestion.StatusSucceeded,
		IndexName:          indexName,
		StoreType:          StoreType,
		Source:             SourceName,
		Operation:          adapter.OperationUpsert,
		RecordCount:        len(request.Records),
		IndexedChunkCount:  len(points),
		SkippedRecordCount: skipped,
		Records:            cloneRecords(request.Records),
		Metadata: map[string]any{
			"collection":         s.collection,
			"qdrantURL":          s.baseURL,
			"idempotencyKey":     request.IdempotencyKey,
			"vectorDimensions":   vectorSize,
			"persistedRecordIds": persistedRecordIDs,
			"skippedRecordIds":   skippedRecordIDs,
		},
	}, nil
}

func (s *Store) Query(ctx context.Context, request adapter.QueryRequest) (adapter.QueryResult, error) {
	filter := buildFilter(request)

	var (
		records []ingestion.IndexRecord
		err     error
	)
	if len(request.QueryVector) > 0 {
		limit := request.TopK
		if limit <= 0 {
			limit = 10
		}
		records, err = s.search(ctx, request.QueryVector, request.SparseVector, limit, filter)
	} else {
		records, err = s.scroll(ctx, request.TopK, filter)
	}
	if err != nil {
		return adapter.QueryResult{}, adapter.ReadError{
			Source:    SourceName,
			Operation: adapter.OperationQuery,
			Retryable: isRetryableError(err),
			Err:       err,
		}
	}

	return adapter.QueryResult{
		Source:  SourceName,
		Records: records,
		Metadata: map[string]any{
			"collection":      s.collection,
			"qdrantURL":       s.baseURL,
			"filteredRecords": len(records),
			"vectorQuery":     len(request.QueryVector) > 0,
			"topK":            request.TopK,
		},
	}, nil
}

func (s *Store) DeleteByDocument(ctx context.Context, request adapter.DeleteByDocumentRequest) (adapter.DeleteResult, error) {
	filter := map[string]any{
		"must": []map[string]any{
			matchValue("knowledgeBaseId", request.KnowledgeBaseID),
			matchValue("documentId", request.DocumentID),
		},
	}
	deleted, err := s.deleteByFilter(ctx, filter)
	if err != nil {
		return adapter.DeleteResult{}, adapter.WriteError{
			Source:    SourceName,
			Operation: adapter.OperationDeleteByDocument,
			Retryable: isRetryableError(err),
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
			"collection": s.collection,
			"qdrantURL":  s.baseURL,
		},
	}, nil
}

func (s *Store) DeleteByKnowledgeBase(ctx context.Context, request adapter.DeleteByKnowledgeBaseRequest) (adapter.DeleteResult, error) {
	filter := map[string]any{
		"must": []map[string]any{
			matchValue("knowledgeBaseId", request.KnowledgeBaseID),
		},
	}
	deleted, err := s.deleteByFilter(ctx, filter)
	if err != nil {
		return adapter.DeleteResult{}, adapter.WriteError{
			Source:    SourceName,
			Operation: adapter.OperationDeleteByKnowledgeBase,
			Retryable: isRetryableError(err),
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
			"collection": s.collection,
			"qdrantURL":  s.baseURL,
		},
	}, nil
}

func (s *Store) ping(ctx context.Context) error {
	var response collectionsResponse
	if err := s.doJSON(ctx, http.MethodGet, "/collections", nil, &response); err != nil {
		return fmt.Errorf("qdrant ping failed: %w", err)
	}
	if !strings.EqualFold(response.Status, "ok") {
		return fmt.Errorf("qdrant ping returned status=%q", response.Status)
	}
	return nil
}

func (s *Store) ensureCollection(ctx context.Context, vectorSize int) error {
	if vectorSize <= 0 {
		return fmt.Errorf("vector size must be positive")
	}

	s.mu.Lock()
	if s.collectionReady {
		if s.collectionVectorSz != vectorSize {
			s.mu.Unlock()
			return fmt.Errorf("qdrant collection %q vector size mismatch: expected=%d got=%d", s.collection, s.collectionVectorSz, vectorSize)
		}
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()

	endpoint := "/collections/" + url.PathEscape(s.collection)
	var info collectionInfoResponse
	err := s.doJSON(ctx, http.MethodGet, endpoint, nil, &info)
	if err == nil {
		s.mu.Lock()
		s.collectionReady = true
		s.collectionVectorSz = vectorSize
		s.mu.Unlock()
		if idxErr := s.ensurePayloadIndexes(ctx); idxErr != nil {
			return idxErr
		}
		return nil
	}

	var httpErr *httpError
	if !errors.As(err, &httpErr) || httpErr.statusCode != http.StatusNotFound {
		return fmt.Errorf("resolve collection failed: %w", err)
	}

	createBody := map[string]any{
		"vectors": map[string]any{
			"dense": map[string]any{
				"size":     vectorSize,
				"distance": "Cosine",
			},
		},
		"sparse_vectors": map[string]any{
			"sparse": map[string]any{},
		},
		"hnsw_config": map[string]any{
			"m":              8,   // Fewer edges per node for small datasets (<100K points).
			"ef_construct":   200, // Higher build-time search depth trades build time for recall.
		},
		"optimizers_config": map[string]any{
			"default_segment_number": 1, // Single segment avoids fragmentation at low volume.
		},
		// Uncomment below to enable scalar quantization — compresses float32
		// vectors to int8 (4x memory reduction) with negligible recall loss
		// for RAG workloads. quantile=0.99 discards the 1% outlier tail.
		// Enable when your dataset exceeds 500K vectors or memory is tight.
		//
		// "quantization_config": map[string]any{
		// 	"scalar": map[string]any{
		// 		"type":       "int8",
		// 		"quantile":   0.99,
		// 		"always_ram": true,
		// 	},
		// },
	}
	if createErr := s.doJSON(ctx, http.MethodPut, endpoint, createBody, &info); createErr != nil {
		return fmt.Errorf("create collection failed: %w", createErr)
	}

	s.mu.Lock()
	s.collectionReady = true
	s.collectionVectorSz = vectorSize
	s.mu.Unlock()
	if idxErr := s.ensurePayloadIndexes(ctx); idxErr != nil {
		return idxErr
	}
	return nil
}

func (s *Store) ensurePayloadIndexes(ctx context.Context) error {
	indexes := []string{"knowledgeBaseId", "documentId", "tenantId", "orgId"}
	for _, field := range indexes {
		endpoint := "/collections/" + url.PathEscape(s.collection) + "/index"
		body := map[string]any{
			"field_name": field,
			"field_type": "keyword",
		}
		// Index creation is idempotent — PUT replaces or creates.
		if err := s.doJSON(ctx, http.MethodPut, endpoint, body, nil); err != nil {
			return fmt.Errorf("create payload index %q failed: %w", field, err)
		}
	}
	return nil
}

func (s *Store) upsertPoints(ctx context.Context, points []point) error {
	endpoint := "/collections/" + url.PathEscape(s.collection) + "/points?wait=true"
	var response upsertResponse
	return s.doJSON(ctx, http.MethodPut, endpoint, upsertRequest{Points: points}, &response)
}

func (s *Store) search(ctx context.Context, queryVector []float32, sparseVector map[string]float32, limit int, filter map[string]any) ([]ingestion.IndexRecord, error) {
	endpoint := "/collections/" + url.PathEscape(s.collection) + "/points/search"
	var sv *qdrantSparseVector
	if len(sparseVector) > 0 {
		sv = mapToSparseVector(sparseVector)
	}
	req := searchRequest{
		Vector:       append([]float32{}, queryVector...),
		SparseVector: sv,
		Limit:        limit,
		Filter:       filter,
		Params:       map[string]any{"hnsw_ef": 256},
		WithPayload:  true,
		WithVector:   true,
	}
	var response searchResponse
	if err := s.doJSON(ctx, http.MethodPost, endpoint, req, &response); err != nil {
		return nil, err
	}

	records := make([]ingestion.IndexRecord, 0, len(response.Result))
	for _, hit := range response.Result {
		record := recordFromPayload(hit.Payload, hit.denseVector())
		record.Metadata["_indexBackend"] = "qdrant"
		record.Metadata["_indexStoreSource"] = SourceName
		record.Metadata["_indexStoreType"] = StoreType
		record.Metadata["_vectorScore"] = hit.Score
		records = append(records, record)
	}
	return records, nil
}

func (s *Store) scroll(ctx context.Context, topK int, filter map[string]any) ([]ingestion.IndexRecord, error) {
	endpoint := "/collections/" + url.PathEscape(s.collection) + "/points/scroll"

	limit := 256
	if topK > 0 && topK < limit {
		limit = topK
	}
	offset := any(nil)
	records := make([]ingestion.IndexRecord, 0, limit)
	for {
		request := scrollRequest{
			Limit:       limit,
			Filter:      filter,
			WithPayload: true,
			WithVector:  true,
			Offset:      offset,
		}
		var response scrollResponse
		if err := s.doJSON(ctx, http.MethodPost, endpoint, request, &response); err != nil {
			var httpErr *httpError
			if errors.As(err, &httpErr) && httpErr.statusCode == http.StatusNotFound {
				return records, nil
			}
			return nil, err
		}

		for _, hit := range response.Result.Points {
			record := recordFromPayload(hit.Payload, hit.denseVector())
			record.Metadata["_indexBackend"] = "qdrant"
			record.Metadata["_indexStoreSource"] = SourceName
			record.Metadata["_indexStoreType"] = StoreType
			records = append(records, record)
			if topK > 0 && len(records) >= topK {
				return records, nil
			}
		}
		if response.Result.NextPageOffset == nil {
			return records, nil
		}
		offset = response.Result.NextPageOffset
	}
}

func (s *Store) deleteByFilter(ctx context.Context, filter map[string]any) (int, error) {
	count, err := s.countByFilter(ctx, filter)
	if err != nil {
		return 0, err
	}
	if count == 0 {
		return 0, nil
	}

	endpoint := "/collections/" + url.PathEscape(s.collection) + "/points/delete?wait=true"
	var response deleteResponse
	if err := s.doJSON(ctx, http.MethodPost, endpoint, deleteRequest{Filter: filter}, &response); err != nil {
		return 0, err
	}
	return count, nil
}

func (s *Store) countByFilter(ctx context.Context, filter map[string]any) (int, error) {
	endpoint := "/collections/" + url.PathEscape(s.collection) + "/points/count"
	var response countResponse
	if err := s.doJSON(ctx, http.MethodPost, endpoint, countRequest{
		Filter: filter,
		Exact:  true,
	}, &response); err != nil {
		var httpErr *httpError
		if errors.As(err, &httpErr) && httpErr.statusCode == http.StatusNotFound {
			return 0, nil
		}
		return 0, err
	}
	return response.Result.Count, nil
}

func (s *Store) doJSON(ctx context.Context, method string, path string, requestBody any, responseBody any) error {
	var payload io.Reader
	if requestBody != nil {
		encoded, err := json.Marshal(requestBody)
		if err != nil {
			return err
		}
		payload = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, s.baseURL+path, payload)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if s.apiKey != "" {
		req.Header.Set("api-key", s.apiKey)
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	responseBytes, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return readErr
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &httpError{
			statusCode: resp.StatusCode,
			body:       strings.TrimSpace(string(responseBytes)),
		}
	}

	if responseBody == nil || len(responseBytes) == 0 {
		return nil
	}
	if err := json.Unmarshal(responseBytes, responseBody); err != nil {
		return fmt.Errorf("decode response failed: %w", err)
	}
	return nil
}

func (s *Store) toPoints(records []ingestion.IndexRecord) (int, []point, int, []string, []string) {
	points := make([]point, 0, len(records))
	vectorSize := 0
	skipped := 0
	persistedRecordIDs := make([]string, 0, len(records))
	skippedRecordIDs := make([]string, 0)
	for _, record := range records {
		recordID := strings.TrimSpace(record.RecordID)
		if len(record.Vector) == 0 {
			skipped++
			if recordID != "" {
				skippedRecordIDs = append(skippedRecordIDs, recordID)
			}
			continue
		}
		if vectorSize == 0 {
			vectorSize = len(record.Vector)
		}
		if len(record.Vector) != vectorSize {
			skipped++
			if recordID != "" {
				skippedRecordIDs = append(skippedRecordIDs, recordID)
			}
			continue
		}
		sparse := tokenizeToSparse(record.Title + " " + record.Content)
		points = append(points, point{
			ID: pointID(record),
			Vector: map[string]any{
				"dense":  append([]float32{}, record.Vector...),
				"sparse": sparse,
			},
			Payload: payloadFromRecord(record),
		})
		if recordID != "" {
			persistedRecordIDs = append(persistedRecordIDs, recordID)
		}
	}
	return vectorSize, points, skipped, persistedRecordIDs, skippedRecordIDs
}

// tokenizeToSparse converts chunk text to a Qdrant sparse vector via the
// gse tokenizer. Terms are hashed to uint32 indices; values are normalized
// term frequencies (TF / maxTF).
func tokenizeToSparse(text string) *qdrantSparseVector {
	terms := keywordsearcher.Tokenize(text)
	if len(terms) == 0 {
		return nil
	}
	tf := make(map[string]float32, len(terms))
	for _, t := range terms {
		tf[t]++
	}
	var maxTF float32
	for _, v := range tf {
		if v > maxTF {
			maxTF = v
		}
	}
	indices := make([]int, 0, len(tf))
	values := make([]float32, 0, len(tf))
	h := fnv.New32a()
	for term, freq := range tf {
		h.Reset()
		h.Write([]byte(term))
		indices = append(indices, int(h.Sum32()))
		values = append(values, freq/maxTF)
	}
	return &qdrantSparseVector{Indices: indices, Values: values}
}

// mapToSparseVector converts a map[string]float32 query sparse vector into
// the wire format expected by Qdrant's search endpoint.
func mapToSparseVector(sparse map[string]float32) *qdrantSparseVector {
	indices := make([]int, 0, len(sparse))
	values := make([]float32, 0, len(sparse))
	h := fnv.New32a()
	for term, weight := range sparse {
		h.Reset()
		h.Write([]byte(term))
		indices = append(indices, int(h.Sum32()))
		values = append(values, weight)
	}
	return &qdrantSparseVector{Indices: indices, Values: values}
}

func pointID(record ingestion.IndexRecord) uint64 {
	raw := strings.TrimSpace(record.RecordID)
	if raw == "" {
		raw = strings.Join([]string{
			record.KnowledgeBaseID,
			record.DocumentID,
			record.ChunkID,
			strconv.Itoa(record.ChunkIndex),
		}, "::")
	}
	sum := sha256.Sum256([]byte(raw))
	return binary.BigEndian.Uint64(sum[:8])
}

func payloadFromRecord(record ingestion.IndexRecord) map[string]any {
	return map[string]any{
		"recordId":        record.RecordID,
		"knowledgeBaseId": record.KnowledgeBaseID,
		"documentId":      record.DocumentID,
		"chunkId":         record.ChunkID,
		"chunkIndex":      record.ChunkIndex,
		"title":           record.Title,
		"content":         record.Content,
		"embeddingRef":    record.EmbeddingRef,
		"source":          record.Source,
		"tenantId":        record.TenantID,
		"orgId":           record.OrgID,
		"metadata":        cloneMap(record.Metadata),
	}
}

func recordFromPayload(payload map[string]any, vector []float32) ingestion.IndexRecord {
	record := ingestion.IndexRecord{
		RecordID:        stringValue(payload["recordId"]),
		KnowledgeBaseID: stringValue(payload["knowledgeBaseId"]),
		DocumentID:      stringValue(payload["documentId"]),
		ChunkID:         stringValue(payload["chunkId"]),
		ChunkIndex:      intValue(payload["chunkIndex"]),
		Title:           stringValue(payload["title"]),
		Content:         stringValue(payload["content"]),
		EmbeddingRef:    stringValue(payload["embeddingRef"]),
		Vector:          append([]float32{}, vector...),
		Source:          stringValue(payload["source"]),
		TenantID:        stringValue(payload["tenantId"]),
		OrgID:           stringValue(payload["orgId"]),
		Metadata:        map[string]any{},
	}
	if metadata, ok := payload["metadata"].(map[string]any); ok {
		record.Metadata = cloneMap(metadata)
	}
	if record.Metadata == nil {
		record.Metadata = map[string]any{}
	}
	return record
}

func buildFilter(request adapter.QueryRequest) map[string]any {
	conditions := make([]map[string]any, 0, 4)
	if tenantID := strings.TrimSpace(request.TenantID); tenantID != "" {
		conditions = append(conditions, matchValue("tenantId", tenantID))
	}
	if orgID := strings.TrimSpace(request.OrgID); orgID != "" {
		conditions = append(conditions, matchValue("orgId", orgID))
	}
	if len(request.KnowledgeBaseIDs) == 1 {
		conditions = append(conditions, matchValue("knowledgeBaseId", request.KnowledgeBaseIDs[0]))
	}
	if len(request.KnowledgeBaseIDs) > 1 {
		values := make([]any, 0, len(request.KnowledgeBaseIDs))
		for _, id := range request.KnowledgeBaseIDs {
			text := strings.TrimSpace(id)
			if text != "" {
				values = append(values, text)
			}
		}
		if len(values) > 0 {
			conditions = append(conditions, map[string]any{
				"key": "knowledgeBaseId",
				"match": map[string]any{
					"any": values,
				},
			})
		}
	}
	if documentID := strings.TrimSpace(request.DocumentID); documentID != "" {
		conditions = append(conditions, matchValue("documentId", documentID))
	}

	for key, value := range request.Filters {
		if strings.TrimSpace(key) == "" || value == nil {
			continue
		}
		switch key {
		case "knowledgeBaseId", "documentId":
			conditions = append(conditions, matchValue(key, fmt.Sprint(value)))
		default:
			conditions = append(conditions, matchValue("metadata."+key, value))
		}
	}

	if len(conditions) == 0 {
		return nil
	}
	return map[string]any{"must": conditions}
}

func matchValue(key string, value any) map[string]any {
	return map[string]any{
		"key": key,
		"match": map[string]any{
			"value": value,
		},
	}
}

func stringValue(value any) string {
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "<nil>" {
		return ""
	}
	return text
}

func intValue(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case float32:
		return int(typed)
	case json.Number:
		parsed, err := typed.Int64()
		if err == nil {
			return int(parsed)
		}
	}
	parsed, err := strconv.Atoi(strings.TrimSpace(fmt.Sprint(value)))
	if err != nil {
		return 0
	}
	return parsed
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
		next := record
		next.Vector = append([]float32{}, record.Vector...)
		next.Metadata = cloneMap(record.Metadata)
		cloned = append(cloned, next)
	}
	return cloned
}

type httpError struct {
	statusCode int
	body       string
}

func (e *httpError) Error() string {
	return fmt.Sprintf("status=%d body=%s", e.statusCode, e.body)
}

func isRetryableError(err error) bool {
	var target *httpError
	if errors.As(err, &target) {
		return target.statusCode >= 500
	}
	return true
}
