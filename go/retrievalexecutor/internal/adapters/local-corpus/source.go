package localcorpus

import (
	"context"
	"strings"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/retrieval/searchutil"
	sourceexecutor "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/retrieval/sourceexecutor"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/retrieval"
)

type Source struct {
	corpus         []corpusDocument
	metadataFilter retrieval.MetadataFilter
}

func NewSource(corpus []corpusDocument) *Source {
	return &Source{
		corpus:         corpus,
		metadataFilter: searchutil.MetadataFilter{},
	}
}

func NewExecutor(corpus []corpusDocument) retrieval.Executor {
	return sourceexecutor.New(sourceexecutor.Config{
		Primary: NewSource(corpus),
	})
}

func (s *Source) Name() string {
	return retrieval.SourceLocalCorpus
}

func (s *Source) Search(_ context.Context, input retrieval.SearchInput) (retrieval.SourceResult, error) {
	queryTerms := searchutil.ExtractTerms(input.Query)

	candidates := make([]retrieval.Chunk, 0, len(s.corpus))
	for _, document := range s.corpus {
		if !searchutil.MatchesKnowledgeBase(document.Chunk, input.KnowledgeBaseIDs) {
			continue
		}

		chunk := searchutil.CloneChunk(document.Chunk)
		chunk.Source = s.Name()
		chunk.Score = scoreChunk(document, queryTerms)
		if chunk.Score <= 0 {
			continue
		}
		candidates = append(candidates, chunk)
	}

	filtered, err := s.metadataFilter.Apply(candidates, input.Filters)
	if err != nil {
		return retrieval.SourceResult{}, err
	}

	searchutil.SortChunks(filtered)

	total := len(filtered)
	if input.TopK > 0 && len(filtered) > input.TopK {
		filtered = filtered[:input.TopK]
	}

	return retrieval.SourceResult{
		Chunks: filtered,
		Total:  total,
	}, nil
}

func scoreChunk(document corpusDocument, queryTerms []string) float64 {
	if len(queryTerms) == 0 {
		return 0
	}

	haystack := strings.ToLower(strings.Join([]string{
		document.Title,
		document.Content,
		strings.Join(document.Terms, " "),
	}, " "))

	var score float64
	for _, term := range queryTerms {
		if strings.Contains(haystack, term) {
			score += 1
		}
	}

	return score
}
