package reranker

import (
	"context"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/retrieval"
)

// NoopReranker returns chunks unchanged. Used as fallback when BGE is unavailable.
type NoopReranker struct{}

func (n NoopReranker) Rerank(_ context.Context, _ string, chunks []retrieval.Chunk, topK int) ([]retrieval.Chunk, error) {
	if topK > 0 && len(chunks) > topK {
		return chunks[:topK], nil
	}
	return chunks, nil
}
