package searchutil

import (
	"fmt"
	"sort"
	"strings"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/retrieval"
)

type MetadataFilter struct{}

func (MetadataFilter) Apply(chunks []retrieval.Chunk, filters map[string]any) ([]retrieval.Chunk, error) {
	if len(filters) == 0 {
		return chunks, nil
	}

	filtered := make([]retrieval.Chunk, 0, len(chunks))
	for _, chunk := range chunks {
		matched, err := MatchesFilters(chunk, filters)
		if err != nil {
			return nil, err
		}
		if matched {
			filtered = append(filtered, chunk)
		}
	}
	return filtered, nil
}

func MatchesKnowledgeBase(chunk retrieval.Chunk, knowledgeBaseIDs []string) bool {
	if len(knowledgeBaseIDs) == 0 {
		return true
	}

	for _, knowledgeBaseID := range knowledgeBaseIDs {
		if knowledgeBaseID == chunk.KnowledgeBaseID {
			return true
		}
	}

	return false
}

func MatchesFilters(chunk retrieval.Chunk, filters map[string]any) (bool, error) {
	for key, rawValue := range filters {
		switch key {
		case "documentId":
			expected := strings.TrimSpace(fmt.Sprint(rawValue))
			if expected != "" && chunk.DocumentID != expected {
				return false, nil
			}
		case "knowledgeBaseId":
			expected := strings.TrimSpace(fmt.Sprint(rawValue))
			if expected != "" && chunk.KnowledgeBaseID != expected {
				return false, nil
			}
		case "tenantId":
			expected := strings.TrimSpace(fmt.Sprint(rawValue))
			if expected != "" && chunk.Metadata["tenantId"] != expected {
				return false, nil
			}
		case "orgId":
			expected := strings.TrimSpace(fmt.Sprint(rawValue))
			if expected != "" && chunk.Metadata["orgId"] != expected {
				return false, nil
			}
		default:
			actual, exists := chunk.Metadata[key]
			if !exists {
				return false, nil
			}
			if !EqualsLoose(actual, rawValue) {
				return false, nil
			}
		}
	}

	return true, nil
}

func EqualsLoose(left any, right any) bool {
	return strings.EqualFold(strings.TrimSpace(fmt.Sprint(left)), strings.TrimSpace(fmt.Sprint(right)))
}

func ExtractTerms(query string) []string {
	splitter := func(r rune) bool {
		return (r < '0' || r > '9') && (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < 0x4e00 || r > 0x9fa5)
	}

	parts := strings.FieldsFunc(strings.ToLower(query), splitter)
	terms := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if len([]rune(part)) >= 2 {
			terms = append(terms, part)
		}
	}

	return terms
}

func CloneChunk(chunk retrieval.Chunk) retrieval.Chunk {
	cloned := retrieval.Chunk{
		ChunkID:         chunk.ChunkID,
		KnowledgeBaseID: chunk.KnowledgeBaseID,
		DocumentID:      chunk.DocumentID,
		Title:           chunk.Title,
		Content:         chunk.Content,
		Score:           chunk.Score,
		Source:          chunk.Source,
		Metadata:        CloneMetadata(chunk.Metadata),
	}

	return cloned
}

func CloneMetadata(metadata map[string]any) map[string]any {
	if len(metadata) == 0 {
		return map[string]any{}
	}

	cloned := make(map[string]any, len(metadata))
	for key, value := range metadata {
		cloned[key] = value
	}

	return cloned
}

func SortChunks(chunks []retrieval.Chunk) {
	sort.SliceStable(chunks, func(i, j int) bool {
		if chunks[i].Score == chunks[j].Score {
			return chunks[i].ChunkID < chunks[j].ChunkID
		}
		return chunks[i].Score > chunks[j].Score
	})
}
