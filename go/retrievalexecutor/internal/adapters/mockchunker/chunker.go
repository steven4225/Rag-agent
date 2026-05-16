package mockchunker

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

type Chunker struct{}

func NewChunker() *Chunker {
	return &Chunker{}
}

func (c *Chunker) Split(_ context.Context, document ingestion.ParsedDocument, _ ingestion.ChunkingExecutionPlan) ([]ingestion.Chunk, int64, error) {
	start := time.Now()
	parts := strings.Split(document.Text, ". ")
	chunks := make([]ingestion.Chunk, 0, len(parts))
	offset := 0

	for index, part := range parts {
		text := strings.TrimSpace(part)
		if text == "" {
			continue
		}

		end := offset + len(text)
		pageNumber := 1
		chunks = append(chunks, ingestion.Chunk{
			ChunkID:    fmt.Sprintf("%s_chunk_%d", document.DocumentID, index+1),
			DocumentID: document.DocumentID,
			ChunkIndex: index,
			Text:       text,
			CharCount:  len(text),
			TokenCount: nil,
			Metadata: ingestion.ChunkMetadata{
				SectionPath: []string{"mock"},
				StartOffset: offset,
				EndOffset:   end,
				PageNumber:  &pageNumber,
			},
		})
		offset = end + 2
	}

	return chunks, time.Since(start).Milliseconds(), nil
}
