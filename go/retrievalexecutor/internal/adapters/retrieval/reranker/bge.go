package reranker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/retrieval"
)

// BGEReranker calls a BGE-Reranker-v2-m3 service via HTTP.
// Default endpoint: http://localhost:8091/rerank
type BGEReranker struct {
	endpoint   string
	httpClient *http.Client
}

func NewBGEReranker(endpoint string) *BGEReranker {
	return &BGEReranker{
		endpoint: endpoint,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

type bgeRequest struct {
	Query     string   `json:"query"`
	Documents []string `json:"documents"`
}

type bgeResponse struct {
	Scores  []float64 `json:"scores"`
	Indices []int     `json:"indices"`
}

func (b *BGEReranker) Rerank(ctx context.Context, query string, chunks []retrieval.Chunk, topK int) ([]retrieval.Chunk, error) {
	if len(chunks) == 0 {
		return chunks, nil
	}

	documents := make([]string, len(chunks))
	for i, chunk := range chunks {
		documents[i] = chunk.Title + " " + chunk.Content
	}

	reqBody := bgeRequest{
		Query:     query,
		Documents: documents,
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("bge reranker marshal: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("bge reranker create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := b.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("bge reranker call: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("bge reranker read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("bge reranker returned status %d: %s", resp.StatusCode, string(respBody))
	}

	var result bgeResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("bge reranker unmarshal: %w", err)
	}

	// Build reranked list with updated scores.
	// indices[i] and scores[i] are parallel arrays from the BGE response.
	reranked := make([]retrieval.Chunk, 0, len(chunks))
	for i, idx := range result.Indices {
		if idx < 0 || idx >= len(chunks) {
			continue
		}
		chunk := chunks[idx]
		if i < len(result.Scores) {
			chunk.Score = result.Scores[i]
		}
		if chunk.Metadata == nil {
			chunk.Metadata = map[string]any{}
		}
		chunk.Metadata["rerankSource"] = "bge-reranker-v2-m3"
		reranked = append(reranked, chunk)
	}

	if topK > 0 && len(reranked) > topK {
		reranked = reranked[:topK]
	}

	return reranked, nil
}
