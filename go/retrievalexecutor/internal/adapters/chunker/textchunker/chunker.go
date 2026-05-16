package textchunker

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

var ErrEmptyChunkSource = errors.New("chunker received empty parsed document")

type Chunker struct {
	embeddingAdapter ingestion.EmbeddingAdapter
}

func NewChunker() *Chunker {
	return &Chunker{}
}

func NewChunkerWithEmbedding(adapter ingestion.EmbeddingAdapter) *Chunker {
	return &Chunker{embeddingAdapter: adapter}
}

func (c *Chunker) Split(ctx context.Context, document ingestion.ParsedDocument, plan ingestion.ChunkingExecutionPlan) ([]ingestion.Chunk, int64, error) {
	start := time.Now()
	if strings.TrimSpace(document.Text) == "" {
		return nil, 0, ErrEmptyChunkSource
	}

	targetSize := plan.TargetSize
	if targetSize <= 0 {
		targetSize = 1200
	}
	overlap := plan.Overlap
	if overlap < 0 {
		overlap = 0
	}
	if overlap >= targetSize {
		overlap = targetSize / 4
	}

	var segments []textSegment
	switch strings.ToLower(strings.TrimSpace(plan.Strategy)) {
	case "", "paragraph":
		segments = splitParagraphSegments(document.Text)
	case "recursive":
		segments = splitRecursiveSegments(document.Text, targetSize, overlap)
	case "semantic":
		var err error
		segments, err = c.semanticSegments(ctx, document, targetSize)
		if err != nil {
			return nil, 0, err
		}
	default:
		segments = splitParagraphSegments(document.Text)
	}

	chunks := make([]ingestion.Chunk, 0, len(segments))
	for _, segment := range segments {
		for _, part := range enforceTargetSize(segment, targetSize, overlap) {
			sectionPath := resolveSectionPath(document.Sections, part.startOffset)
			chunks = append(chunks, ingestion.Chunk{
				ChunkID:    fmt.Sprintf("%s_chunk_%d", document.DocumentID, len(chunks)+1),
				DocumentID: document.DocumentID,
				ChunkIndex: len(chunks),
				Text:       part.text,
				CharCount:  len(part.text),
				TokenCount: nil,
				Metadata: ingestion.ChunkMetadata{
					SectionPath: sectionPath,
					StartOffset: part.startOffset,
					EndOffset:   part.endOffset,
					PageNumber:  nil,
				},
			})
		}
	}

	if len(chunks) == 0 {
		return nil, 0, ErrEmptyChunkSource
	}

	return chunks, time.Since(start).Milliseconds(), nil
}

type textSegment struct {
	text        string
	startOffset int
	endOffset   int
}

func splitParagraphSegments(text string) []textSegment {
	segments := make([]textSegment, 0)
	start := 0
	for start < len(text) {
		next := strings.Index(text[start:], "\n\n")
		end := len(text)
		if next >= 0 {
			end = start + next
		}

		chunkText := strings.TrimSpace(text[start:end])
		if chunkText != "" {
			trimmedStart := start + strings.Index(text[start:end], chunkText)
			segments = append(segments, textSegment{
				text:        chunkText,
				startOffset: trimmedStart,
				endOffset:   trimmedStart + len(chunkText),
			})
		}

		if next < 0 {
			break
		}
		start = end + 2
	}

	if len(segments) == 0 {
		segments = append(segments, textSegment{
			text:        strings.TrimSpace(text),
			startOffset: 0,
			endOffset:   len(strings.TrimSpace(text)),
		})
	}

	return segments
}

func splitRecursiveSegments(text string, targetSize, overlap int) []textSegment {
	segments := make([]textSegment, 0)
	cursor := 0
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return segments
	}

	for cursor < len(text) {
		end := cursor + targetSize
		if end > len(text) {
			end = len(text)
		}

		slice := strings.TrimSpace(text[cursor:end])
		if slice != "" {
			leadingIndex := strings.Index(text[cursor:end], slice)
			startOffset := cursor
			if leadingIndex >= 0 {
				startOffset += leadingIndex
			}
			segments = append(segments, textSegment{
				text:        slice,
				startOffset: startOffset,
				endOffset:   startOffset + len(slice),
			})
		}

		if end == len(text) {
			break
		}

		cursor = end - overlap
		if cursor < 0 {
			cursor = 0
		}
	}

	return segments
}

func enforceTargetSize(segment textSegment, targetSize, overlap int) []textSegment {
	if len(segment.text) <= targetSize {
		return []textSegment{segment}
	}

	parts := make([]textSegment, 0)
	cursor := 0
	for cursor < len(segment.text) {
		end := cursor + targetSize
		if end > len(segment.text) {
			end = len(segment.text)
		}
		partText := strings.TrimSpace(segment.text[cursor:end])
		if partText != "" {
			leadingIndex := strings.Index(segment.text[cursor:end], partText)
			startOffset := segment.startOffset + cursor
			if leadingIndex >= 0 {
				startOffset += leadingIndex
			}
			parts = append(parts, textSegment{
				text:        partText,
				startOffset: startOffset,
				endOffset:   startOffset + len(partText),
			})
		}
		if end == len(segment.text) {
			break
		}
		cursor = end - overlap
		if cursor < 0 {
			cursor = 0
		}
	}
	return parts
}

func resolveSectionPath(sections []ingestion.ParsedSection, startOffset int) []string {
	if len(sections) == 0 {
		return []string{}
	}

	for _, section := range sections {
		if startOffset >= section.StartOffset && startOffset < section.EndOffset {
			if section.Title == "" {
				return []string{section.SectionID}
			}
			return []string{section.Title}
		}
	}

	last := sections[len(sections)-1]
	if last.Title == "" {
		return []string{last.SectionID}
	}
	return []string{last.Title}
}
