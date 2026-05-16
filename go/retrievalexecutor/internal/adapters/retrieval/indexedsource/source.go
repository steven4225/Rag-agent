package indexedsource

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	adapter "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexstore"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/retrieval/keywordsearcher"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/retrieval/reranker"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/retrieval/searchutil"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/retrieval/vectorsearch"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/retrieval"
)

var (
	ErrEmbeddingAdapterRequired = errors.New("vector retrieval mode requires embedding adapter")
	ErrVectorCandidatesEmpty    = errors.New("vector retrieval produced no candidates")

	cachedSearcher = keywordsearcher.NewCachedSearcher()
)

type Config struct {
	Store            adapter.Adapter
	EmbeddingAdapter ingestion.EmbeddingAdapter
	RetrievalMode    string
	RerankAdapter    retrieval.RerankAdapter
}

type Source struct {
	store            adapter.Adapter
	embeddingAdapter ingestion.EmbeddingAdapter
	retrievalMode    string
	metadataFilter   retrieval.MetadataFilter
	rerankAdapter    retrieval.RerankAdapter
}

func NewSource(store adapter.Adapter) *Source {
	return NewSourceWithConfig(Config{
		Store:         store,
		RetrievalMode: retrieval.RetrievalModeKeyword,
	})
}

func NewSourceWithConfig(config Config) *Source {
	ra := config.RerankAdapter
	if ra == nil {
		ra = reranker.NoopReranker{}
	}
	return &Source{
		store:            config.Store,
		embeddingAdapter: config.EmbeddingAdapter,
		retrievalMode:    normalizeRetrievalMode(config.RetrievalMode),
		metadataFilter:   searchutil.MetadataFilter{},
		rerankAdapter:    ra,
	}
}

func (s *Source) Name() string {
	return retrieval.SourceIndexedStore
}

func (s *Source) Search(ctx context.Context, input retrieval.SearchInput) (retrieval.SourceResult, error) {
	queryVector := []float32(nil)
	queryEmbeddingProvider := ""
	queryEmbeddingModel := ""
	querySparseVector := map[string]float32(nil)
	if s.retrievalMode == retrieval.RetrievalModeVector || s.retrievalMode == retrieval.RetrievalModeHybrid {
		vector, provider, model, embeddingErr := s.queryEmbedding(ctx, input)
		if embeddingErr != nil {
			if s.retrievalMode == retrieval.RetrievalModeVector {
				return retrieval.SourceResult{}, embeddingErr
			}
		} else {
			queryVector = vector
			queryEmbeddingProvider = provider
			queryEmbeddingModel = model
		}
		// Build query sparse vector for native hybrid search.
		// Each unique token gets equal query weight 鈥?Qdrant RRF handles
		// the fusion with the dense vector on its side.
		if s.retrievalMode == retrieval.RetrievalModeHybrid {
			querySparseVector = querySparseTerms(input.Query)
		}
	}

	queryResult, err := s.store.Query(ctx, adapter.QueryRequest{
		TraceID:          input.TraceID,
		KnowledgeBaseIDs: input.KnowledgeBaseIDs,
		DocumentID:       documentIDFilter(input.Filters),
		TenantID:         input.TenantID,
		OrgID:            input.OrgID,
		QueryVector:      queryVector,
		SparseVector:     querySparseVector,
		TopK:             input.TopK,
		Filters:          searchutil.CloneMetadata(input.Filters),
		Metadata: map[string]any{
			"requestedSource": retrieval.SourceIndexedStore,
			"retrievalMode":   s.retrievalMode,
		},
	})
	if err != nil {
		return retrieval.SourceResult{}, err
	}

	candidates, err := s.searchByMode(ctx, input, queryResult.Records, queryVector, queryEmbeddingProvider, queryEmbeddingModel)
	if err != nil {
		return retrieval.SourceResult{}, err
	}

	filtered, err := s.metadataFilter.Apply(candidates, input.Filters)
	if err != nil {
		return retrieval.SourceResult{}, err
	}

	searchutil.SortChunks(filtered)
	total := len(filtered)

	// Rerank: send top candidates (up to 20) to Cross-Encoder for fine-grained scoring.
	// We fuse retrieval scores with reranker scores (weighted blend) instead of
	// replacing them 鈥?this preserves the ranking signal from the index.
	rerankCandidateCount := 20
	if rerankCandidateCount > len(filtered) {
		rerankCandidateCount = len(filtered)
	}
	rerankCandidates := filtered[:rerankCandidateCount]

	retrievalScores := make(map[string]float64, rerankCandidateCount)
	for _, c := range rerankCandidates {
		retrievalScores[c.ChunkID] = c.Score
	}

	reranked, rerankErr := s.rerankAdapter.Rerank(ctx, input.Query, rerankCandidates, 0)
	if rerankErr == nil && len(reranked) > 0 {
		fuseScores(reranked, retrievalScores)
		searchutil.SortChunks(reranked)
		filtered = append(reranked, filtered[rerankCandidateCount:]...)
	} else {
		slog.Warn("rerank failed, falling back to original order", "error", rerankErr)
	}

	// Final TopK cut
	if input.TopK > 0 && len(filtered) > input.TopK {
		filtered = filtered[:input.TopK]
	}

	return retrieval.SourceResult{
		Chunks: filtered,
		Total:  total,
	}, nil
}

func (s *Source) searchByMode(
	ctx context.Context,
	input retrieval.SearchInput,
	records []ingestion.IndexRecord,
	queryVector []float32,
	queryEmbeddingProvider string,
	queryEmbeddingModel string,
) ([]retrieval.Chunk, error) {
	switch s.retrievalMode {
	case retrieval.RetrievalModeVector:
		result, reason, err := s.vectorCandidates(ctx, input, records, retrieval.RetrievalModeVector, retrieval.ScoreSourceVector, queryVector, queryEmbeddingProvider, queryEmbeddingModel)
		if err != nil {
			return nil, err
		}
		if len(result) == 0 {
			return nil, fmt.Errorf("%w: %s", ErrVectorCandidatesEmpty, reason)
		}
		return result, nil
	case retrieval.RetrievalModeHybrid:
		chunks, _ := nativeHybridChunks(records, retrieval.RetrievalModeHybrid, retrieval.ScoreSourceHybrid, queryEmbeddingProvider, queryEmbeddingModel)
		if len(chunks) > 0 {
			return chunks, nil
		}
		// Fall back to keyword when records lack _vectorScore (e.g. stub store
		// in tests, or a non-Qdrant backend used with hybrid mode).
		return keywordCandidates(records, input, retrieval.RetrievalModeHybrid, "native-hybrid-empty")
	default:
		return keywordCandidates(records, input, retrieval.RetrievalModeKeyword, "")
	}
}

// nativeHybridChunks converts pre-scored records from Qdrant's native hybrid
// search into chunks. The store already performed sparse+dense fusion (RRF),
// so each record carries _vectorScore from Qdrant's fusion score.
func nativeHybridChunks(records []ingestion.IndexRecord, retrievalMode string, scoreSource string, embeddingProvider string, embeddingModel string) ([]retrieval.Chunk, error) {
	candidates := make([]retrieval.Chunk, 0, len(records))
	for _, record := range records {
		score := 0.0
		if storeScore, ok := record.Metadata["_vectorScore"].(float64); ok {
			score = storeScore
		}
		if score < minRetrievalScore {
			continue
		}
		chunk := mapRecordToChunk(record, retrieval.SourceIndexedStore)
		chunk.Score = score
		chunk.Metadata["scoreSource"] = scoreSource
		chunk.Metadata["retrievalMode"] = retrievalMode
		chunk.Metadata["queryEmbeddingProvider"] = embeddingProvider
		chunk.Metadata["queryEmbeddingModel"] = embeddingModel
		if backend, ok := record.Metadata["_indexBackend"]; ok {
			chunk.Metadata["vectorSearchBackend"] = backend
		}
		candidates = append(candidates, chunk)
	}
	return candidates, nil
}

// querySparseTerms tokenizes the query and returns a weight-1 sparse vector
// for Qdrant native hybrid search. Each unique token maps to 1.0 鈥?RRF
// handles the fusion weight calibration, so uniform query weights are correct.
func querySparseTerms(query string) map[string]float32 {
	terms := keywordsearcher.Tokenize(query)
	if len(terms) == 0 {
		return nil
	}
	vec := make(map[string]float32, len(terms))
	for _, t := range terms {
		vec[t] = 1.0
	}
	return vec
}

func (s *Source) vectorCandidates(
	ctx context.Context,
	input retrieval.SearchInput,
	records []ingestion.IndexRecord,
	retrievalMode string,
	scoreSource string,
	queryVector []float32,
	queryEmbeddingProvider string,
	queryEmbeddingModel string,
) ([]retrieval.Chunk, string, error) {
	provider := queryEmbeddingProvider
	model := queryEmbeddingModel
	if len(queryVector) == 0 {
		var err error
		queryVector, provider, model, err = s.queryEmbedding(ctx, input)
		if err != nil {
			return nil, "query-embedding-failed", err
		}
	}

	skippedMissingVector := 0
	skippedDimensionMismatch := 0
	candidates := make([]retrieval.Chunk, 0, len(records))
	for _, record := range records {
		chunk := mapRecordToChunk(record, s.Name())
		if !searchutil.MatchesKnowledgeBase(chunk, input.KnowledgeBaseIDs) {
			continue
		}

		var score float64
		if storeScore, ok := record.Metadata["_vectorScore"].(float64); ok {
			// Use the store's native vector score (e.g., Qdrant ANN) instead of recomputing.
			score = storeScore
			chunk.Metadata["vectorSearchBackend"] = record.Metadata["_indexBackend"]
		} else {
			// Fall back to brute-force cosine similarity for stores without native vector search.
			if len(record.Vector) == 0 {
				skippedMissingVector++
				continue
			}
			if len(record.Vector) != len(queryVector) {
				skippedDimensionMismatch++
				continue
			}
			scoreErr := error(nil)
			score, scoreErr = vectorsearch.CosineSimilarity(queryVector, record.Vector)
			if scoreErr != nil {
				skippedDimensionMismatch++
				continue
			}
		}
		if score < minRetrievalScore {
			continue
		}

		chunk.Score = score
		chunk.Metadata["scoreSource"] = scoreSource
		chunk.Metadata["retrievalMode"] = retrievalMode
		chunk.Metadata["vectorDimensions"] = len(record.Vector)
		chunk.Metadata["queryVectorDimensions"] = len(queryVector)
		chunk.Metadata["queryEmbeddingProvider"] = provider
		chunk.Metadata["queryEmbeddingModel"] = model
		candidates = append(candidates, chunk)
	}

	reason := vectorSkipReason(skippedMissingVector, skippedDimensionMismatch, len(candidates))
	return candidates, reason, nil
}

func (s *Source) queryEmbedding(ctx context.Context, input retrieval.SearchInput) ([]float32, string, string, error) {
	if s.embeddingAdapter == nil {
		return nil, "", "", ErrEmbeddingAdapterRequired
	}

	result, err := s.embeddingAdapter.Embed(ctx, ingestion.EmbeddingRequest{
		TraceID: input.TraceID,
		Inputs: []ingestion.EmbeddingInput{
			{
				ChunkID:     "retrieval-query",
				DocumentID:  "",
				ChunkIndex:  0,
				Text:        input.Query,
				CharCount:   len([]rune(input.Query)),
				ContentHash: hashText(input.Query),
			},
		},
		Metadata: map[string]any{
			"adapter": "retrieval-query",
			"purpose": "indexed-store-vector-search",
		},
	})
	if err != nil {
		return nil, "", "", err
	}
	if len(result.Artifacts) == 0 || len(result.Artifacts[0].Vector) == 0 {
		return nil, "", "", ErrVectorCandidatesEmpty
	}

	provider := metadataString(result.Metadata, "embeddingProvider", "")
	model := metadataString(result.Metadata, "embeddingModel", result.Model)
	return result.Artifacts[0].Vector, provider, model, nil
}

func keywordCandidates(records []ingestion.IndexRecord, input retrieval.SearchInput, retrievalMode string, fallbackReason string) ([]retrieval.Chunk, error) {
	chunks := recordsToChunks(records)
	filtered := filterByKnowledgeBase(chunks, input.KnowledgeBaseIDs)

	scored, err := cachedSearcher.Search(filtered, input.Query)
	if err != nil {
		return nil, err
	}

	for i := range scored {
		scored[i].Metadata["retrievalMode"] = retrievalMode
		if fallbackReason != "" {
			scored[i].Metadata["vectorFallbackReason"] = fallbackReason
		}
	}

	return scored, nil
}

func recordsToChunks(records []ingestion.IndexRecord) []retrieval.Chunk {
	chunks := make([]retrieval.Chunk, 0, len(records))
	for _, record := range records {
		chunks = append(chunks, mapRecordToChunk(record, retrieval.SourceIndexedStore))
	}
	return chunks
}

func filterByKnowledgeBase(chunks []retrieval.Chunk, knowledgeBaseIDs []string) []retrieval.Chunk {
	if len(knowledgeBaseIDs) == 0 {
		return chunks
	}
	filtered := make([]retrieval.Chunk, 0, len(chunks))
	for _, chunk := range chunks {
		if searchutil.MatchesKnowledgeBase(chunk, knowledgeBaseIDs) {
			filtered = append(filtered, chunk)
		}
	}
	return filtered
}

func normalizeRetrievalMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case retrieval.RetrievalModeVector:
		return retrieval.RetrievalModeVector
	case retrieval.RetrievalModeHybrid:
		return retrieval.RetrievalModeHybrid
	default:
		return retrieval.RetrievalModeKeyword
	}
}

func mapRecordToChunk(record ingestion.IndexRecord, sourceName string) retrieval.Chunk {
	chunkID := strings.TrimSpace(record.ChunkID)
	if chunkID == "" {
		chunkID = strings.TrimSpace(record.RecordID)
	}

	metadata := searchutil.CloneMetadata(record.Metadata)
	metadata["recordId"] = record.RecordID
	metadata["chunkIndex"] = record.ChunkIndex
	if strings.TrimSpace(record.TenantID) != "" {
		metadata["tenantId"] = record.TenantID
	}
	if strings.TrimSpace(record.OrgID) != "" {
		metadata["orgId"] = record.OrgID
	}
	if strings.TrimSpace(record.EmbeddingRef) != "" {
		metadata["embeddingRef"] = record.EmbeddingRef
	}
	if len(record.Vector) > 0 {
		metadata["vectorDimensions"] = len(record.Vector)
	}
	if strings.TrimSpace(record.Source) != "" {
		metadata["indexRecordSource"] = record.Source
	}

	return retrieval.Chunk{
		ChunkID:         chunkID,
		KnowledgeBaseID: record.KnowledgeBaseID,
		DocumentID:      record.DocumentID,
		Title:           record.Title,
		Content:         record.Content,
		Source:          sourceName,
		Metadata:        metadata,
	}
}

func hashText(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func vectorSkipReason(skippedMissingVector int, skippedDimensionMismatch int, matchedCandidates int) string {
	if matchedCandidates > 0 {
		return ""
	}
	reasons := make([]string, 0, 2)
	if skippedMissingVector > 0 {
		reasons = append(reasons, fmt.Sprintf("missing-vector:%d", skippedMissingVector))
	}
	if skippedDimensionMismatch > 0 {
		reasons = append(reasons, fmt.Sprintf("dimension-mismatch:%d", skippedDimensionMismatch))
	}
	if len(reasons) == 0 {
		return "no-positive-similarity"
	}
	return strings.Join(reasons, ",")
}

func metadataString(metadata map[string]any, key string, fallback string) string {
	value, ok := metadata[key]
	if !ok {
		return fallback
	}
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "" {
		return fallback
	}
	return text
}

func documentIDFilter(filters map[string]any) string {
	value, ok := filters["documentId"]
	if !ok {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

const (
	retrievalWeight    = 0.3
	rerankWeight       = 0.7
	minRetrievalScore  = 0.3
)

// fuseScores blends retrieval scores with reranker scores via weighted sum
// after min-max normalisation, so neither ranking signal is discarded.
func fuseScores(chunks []retrieval.Chunk, retrievalScores map[string]float64) {
	if len(chunks) == 0 {
		return
	}

	retScores := make([]float64, 0, len(chunks))
	rerankScores := make([]float64, 0, len(chunks))
	for _, c := range chunks {
		retScores = append(retScores, retrievalScores[c.ChunkID])
		rerankScores = append(rerankScores, c.Score)
	}
	retMin, retMax := minMax(retScores)
	rerankMin, rerankMax := minMax(rerankScores)

	for i := range chunks {
		retScore := retrievalScores[chunks[i].ChunkID]
		normRet := normalize(retScore, retMin, retMax)
		normRerank := normalize(chunks[i].Score, rerankMin, rerankMax)
		chunks[i].Score = retrievalWeight*normRet + rerankWeight*normRerank
	}
}

func normalize(score, min, max float64) float64 {
	if max == min {
		return 0.5
	}
	return (score - min) / (max - min)
}

func minMax(scores []float64) (float64, float64) {
	if len(scores) == 0 {
		return 0, 1
	}
	min, max := scores[0], scores[0]
	for _, s := range scores[1:] {
		if s < min {
			min = s
		}
		if s > max {
			max = s
		}
	}
	return min, max
}

func BM25CacheStats() keywordsearcher.CacheStats {
	return cachedSearcher.Stats()
}
