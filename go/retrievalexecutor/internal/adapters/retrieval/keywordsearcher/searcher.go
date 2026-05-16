package keywordsearcher

import (
	"sort"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/retrieval"
)

// Searcher builds an in-memory BM25 index over chunks and scores queries against it.
type Searcher struct {
	params      BM25Params
	chunks      []retrieval.Chunk
	docTokens   [][]string
	docFreq     map[string]int
	avgDocLen   float64
	titleTokens [][]string
}

// NewSearcher creates a Searcher with default BM25 parameters.
func NewSearcher() *Searcher {
	return &Searcher{params: DefaultBM25Params()}
}

// BuildIndex tokenizes all chunks and builds in-memory document frequency stats.
func (s *Searcher) BuildIndex(chunks []retrieval.Chunk) {
	s.chunks = chunks
	s.docTokens = make([][]string, len(chunks))
	s.titleTokens = make([][]string, len(chunks))

	for i, chunk := range chunks {
		docText := chunk.Title + " " + chunk.Content
		s.docTokens[i] = Tokenize(docText)
		s.titleTokens[i] = Tokenize(chunk.Title)
	}

	s.docFreq = buildDocFreq(s.docTokens)
	s.avgDocLen = avgDocLength(s.docTokens)
}

// Search scores all indexed chunks against the query and returns topK results.
// Returns the full chunk list sorted by BM25 score; caller is responsible for
// truncation by TopK.
func (s *Searcher) Search(query string) []retrieval.Chunk {
	queryTerms := Tokenize(query)
	if len(queryTerms) == 0 || len(s.chunks) == 0 {
		return nil
	}

	totalDocs := len(s.chunks)
	scored := make([]retrieval.Chunk, 0, len(s.chunks))

	for i, chunk := range s.chunks {
		bodyScore := BM25Score(queryTerms, s.docTokens[i], totalDocs, s.docFreq, s.avgDocLen, s.params)
		// Title terms get a small boost via separate BM25 scoring on title-only "doc"
		titleScore := 0.0
		if len(s.titleTokens[i]) > 0 {
			titleAvgLen := s.avgDocLen
			if titleAvgLen == 0 {
				titleAvgLen = 1
			}
			titleScore = BM25Score(queryTerms, s.titleTokens[i], totalDocs, s.docFreq, titleAvgLen, s.params) * 0.3
		}

		score := bodyScore + titleScore
		if score <= 0 {
			continue
		}

		chunkCopy := chunk
		chunkCopy.Score = score
		chunkCopy.Metadata = cloneMetadata(chunk.Metadata)
		chunkCopy.Metadata["scoreSource"] = retrieval.ScoreSourceKeyword
		scored = append(scored, chunkCopy)
	}

	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].Score == scored[j].Score {
			return scored[i].ChunkID < scored[j].ChunkID
		}
		return scored[i].Score > scored[j].Score
	})

	return scored
}

func cloneMetadata(src map[string]any) map[string]any {
	if len(src) == 0 {
		return map[string]any{}
	}
	dst := make(map[string]any, len(src))
	for k, v := range src {
		dst[k] = v
	}
	return dst
}
