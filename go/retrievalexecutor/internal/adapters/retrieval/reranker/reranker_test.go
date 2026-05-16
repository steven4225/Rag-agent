package reranker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/retrieval"
)

func TestNoopRerankerPreservesOrder(t *testing.T) {
	chunks := []retrieval.Chunk{
		{ChunkID: "a", Score: 0.9, Title: "A", Content: "Content A"},
		{ChunkID: "b", Score: 0.5, Title: "B", Content: "Content B"},
		{ChunkID: "c", Score: 0.2, Title: "C", Content: "Content C"},
	}

	r := NoopReranker{}
	result, err := r.Rerank(context.Background(), "query", chunks, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != 2 {
		t.Errorf("expected 2 results, got %d", len(result))
	}
	if result[0].ChunkID != "a" || result[1].ChunkID != "b" {
		t.Errorf("expected [a, b], got [%s, %s]", result[0].ChunkID, result[1].ChunkID)
	}
}

func TestNoopRerankerEmptyInput(t *testing.T) {
	r := NoopReranker{}
	result, err := r.Rerank(context.Background(), "query", nil, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != 0 {
		t.Errorf("expected 0 results, got %d", len(result))
	}
}

func TestBGERerankerIntegration(t *testing.T) {
	// Spin up a fake BGE HTTP server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req bgeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		// Return scores: higher for docs containing the query term
		scores := make([]float64, len(req.Documents))
		indices := make([]int, len(req.Documents))
		for i, doc := range req.Documents {
			if len(doc) > 0 && len(req.Query) > 0 {
				// Simple mock: score inversely proportional to index for test stability
				scores[i] = 1.0 - float64(i)*0.1
			}
			indices[i] = i
		}

		resp := bgeResponse{Scores: scores, Indices: indices}
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	reranker := NewBGEReranker(server.URL)

	chunks := []retrieval.Chunk{
		{ChunkID: "c1", Title: "Leave Policy", Content: "Annual leave rules."},
		{ChunkID: "c2", Title: "Payroll", Content: "Payroll closes 25th."},
		{ChunkID: "c3", Title: "Incident", Content: "P1 incident response."},
	}

	result, err := reranker.Rerank(context.Background(), "leave policy", chunks, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != 2 {
		t.Errorf("expected 2 results, got %d", len(result))
	}
	// Reranker metadata should be set
	if result[0].Metadata["rerankSource"] != "bge-reranker-v2-m3" {
		t.Error("expected rerankSource metadata on result")
	}
}

func TestBGERerankerEmptyChunks(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(bgeResponse{})
	}))
	defer server.Close()

	reranker := NewBGEReranker(server.URL)
	result, err := reranker.Rerank(context.Background(), "query", nil, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != 0 {
		t.Errorf("expected 0 results, got %d", len(result))
	}
}

func TestBGERerankerServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	reranker := NewBGEReranker(server.URL)
	chunks := []retrieval.Chunk{{ChunkID: "x", Title: "T", Content: "C"}}
	_, err := reranker.Rerank(context.Background(), "query", chunks, 1)
	if err == nil {
		t.Error("expected error on 500 response")
	}
}
