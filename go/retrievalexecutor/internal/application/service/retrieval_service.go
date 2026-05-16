package service

import (
	"context"
	"errors"
	"strings"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/retrieval"
	"github.com/nageoffer/ragent/go/retrievalexecutor/pkg/contracts"
)

var ErrInvalidRequest = errors.New("invalid retrieval request")

type RetrievalService struct {
	executor retrieval.Executor
}

func NewRetrievalService(executor retrieval.Executor) *RetrievalService {
	return &RetrievalService{executor: executor}
}

func (s *RetrievalService) Search(ctx context.Context, request contracts.RetrievalSearchRequest) (contracts.RetrievalSearchResponse, error) {
	if strings.TrimSpace(request.TraceID) == "" || strings.TrimSpace(request.Query) == "" {
		return contracts.RetrievalSearchResponse{}, ErrInvalidRequest
	}

	topK := request.TopK
	if topK <= 0 {
		topK = retrieval.DefaultTopK
	}
	if topK > retrieval.MaxTopK {
		topK = retrieval.MaxTopK
	}

	result, err := s.executor.Search(ctx, retrieval.SearchInput{
		TraceID:          request.TraceID,
		Query:            request.Query,
		ConversationID:   request.ConversationID,
		UserID:           request.UserID,
		TenantID:         request.TenantID,
		OrgID:            request.OrgID,
		KnowledgeBaseIDs: request.KnowledgeBaseIDs,
		TopK:             topK,
		Filters:          cloneMap(request.Filters),
	})
	if err != nil {
		return contracts.RetrievalSearchResponse{}, err
	}

	responseChunks := make([]contracts.RetrievalChunk, 0, len(result.Chunks))
	for _, chunk := range result.Chunks {
		responseChunks = append(responseChunks, contracts.RetrievalChunk{
			ChunkID:         chunk.ChunkID,
			KnowledgeBaseID: chunk.KnowledgeBaseID,
			DocumentID:      chunk.DocumentID,
			Title:           chunk.Title,
			Content:         chunk.Content,
			Score:           chunk.Score,
			Source:          chunk.Source,
			Metadata:        cloneMap(chunk.Metadata),
		})
	}

	return contracts.RetrievalSearchResponse{
		TraceID:   result.TraceID,
		Chunks:    responseChunks,
		Total:     result.Total,
		LatencyMs: result.LatencyMs,
		Timing: contracts.RetrievalTiming{
			TotalMs: result.LatencyMs,
		},
		Source: result.Source,
	}, nil
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
