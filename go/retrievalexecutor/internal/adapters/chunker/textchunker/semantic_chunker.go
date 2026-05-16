package textchunker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"strings"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

const (
	defaultSemanticThreshold = 0.6
)

type sentenceSpan struct {
	text        string
	startOffset int
	endOffset   int
}

// splitSentences splits text into sentences on Chinese punctuation and newlines,
// tracking byte offsets into the original text.
func splitSentences(text string) []sentenceSpan {
	var spans []sentenceSpan
	var current []rune
	byteStart := 0
	byteCursor := 0

	runes := []rune(text)
	for i, r := range runes {
		current = append(current, r)
		byteLen := len(string(r))
		byteCursor += byteLen

		if r == '。' || r == '！' || r == '？' || r == '\n' {
			s := strings.TrimSpace(string(current))
			if len([]rune(s)) > 0 {
				// Find where trimmed text starts in the original
				trimStart := byteStart
				spans = append(spans, sentenceSpan{
					text:        s,
					startOffset: trimStart,
					endOffset:   byteCursor,
				})
			}
			current = nil
			byteStart = byteCursor
		}
		_ = i
	}

	if len(current) > 0 {
		s := strings.TrimSpace(string(current))
		if len([]rune(s)) > 0 {
			spans = append(spans, sentenceSpan{
				text:        s,
				startOffset: byteStart,
				endOffset:   len(text),
			})
		}
	}

	return spans
}

// semanticSegments uses structural boundaries as the primary signal, falling
// back to embedding-based similarity only for long unstructured paragraphs.
// Structured elements (headings, lists, Q&A, code blocks) are inherently
// coherent and kept as segments without embedding calls.
func (c *Chunker) semanticSegments(ctx context.Context, document ingestion.ParsedDocument, targetSize int) ([]textSegment, error) {
	blocks := splitStructural(document.Text)
	if len(blocks) == 0 {
		return nil, fmt.Errorf("semantic chunker: document has no structural blocks")
	}

	var segments []textSegment
	for _, block := range blocks {
		segs, err := c.processStructuralBlock(ctx, document, block, targetSize)
		if err != nil {
			return nil, err
		}
		segments = append(segments, segs...)
	}

	if len(segments) == 0 {
		return nil, fmt.Errorf("semantic chunker: produced no segments")
	}

	return segments, nil
}

func (c *Chunker) processStructuralBlock(ctx context.Context, document ingestion.ParsedDocument, block structuralBlock, targetSize int) ([]textSegment, error) {
	charCount := len([]rune(block.text))

	// Small blocks are fine as-is.
	if charCount <= targetSize {
		return []textSegment{{text: block.text, startOffset: block.startOffset, endOffset: block.endOffset}}, nil
	}

	switch block.blockType {
	case structParagraph:
		// Long paragraphs need embedding-based sub-splitting.
		if c.embeddingAdapter != nil {
			segs, err := c.splitParagraphByEmbedding(ctx, document, block, targetSize)
			if err == nil && len(segs) > 1 {
				return segs, nil
			}
			// On embedding failure, fall through to recursive split.
		}
		return offsetSegments(splitRecursiveSegments(block.text, targetSize, targetSize/10), block.startOffset), nil

	case structList:
		// Lists: split at item boundaries, falling back to recursive if single huge item.
		return splitListBlock(block, targetSize), nil

	default:
		// Headings, Q&A, code, dividers — keep intact even if slightly over targetSize.
		// These are semantic atoms; forcing a split loses information.
		return []textSegment{{text: block.text, startOffset: block.startOffset, endOffset: block.endOffset}}, nil
	}
}

// splitParagraphByEmbedding extracts the embedding-based splitting logic for a
// single paragraph block. Sentences are embedded in one batch and split at
// cosine similarity drop-offs (< 0.6).
func (c *Chunker) splitParagraphByEmbedding(ctx context.Context, document ingestion.ParsedDocument, block structuralBlock, targetSize int) ([]textSegment, error) {
	spans := splitSentences(block.text)
	if len(spans) <= 1 {
		return offsetSegments(splitRecursiveSegments(block.text, targetSize, targetSize/10), block.startOffset), nil
	}

	inputs := make([]ingestion.EmbeddingInput, len(spans))
	for i, sp := range spans {
		inputs[i] = ingestion.EmbeddingInput{
			ChunkID:     fmt.Sprintf("%s_sent_%d", document.DocumentID, i),
			DocumentID:  document.DocumentID,
			ChunkIndex:  i,
			Text:        sp.text,
			CharCount:   len([]rune(sp.text)),
			ContentHash: hashSemantic(sp.text),
		}
	}

	result, err := c.embeddingAdapter.Embed(ctx, ingestion.EmbeddingRequest{
		TraceID:    document.DocumentID,
		DocumentID: document.DocumentID,
		Inputs:     inputs,
		Metadata:   map[string]any{"purpose": "semantic-chunking-paragraph"},
	})
	if err != nil {
		return nil, fmt.Errorf("semantic chunker embed: %w", err)
	}

	if len(result.Artifacts) != len(spans) {
		return nil, fmt.Errorf("semantic chunker: expected %d embeddings, got %d", len(spans), len(result.Artifacts))
	}

	breakpoints := findSemanticBreakpoints(result.Artifacts, defaultSemanticThreshold)
	segs := mergeSpans(spans, breakpoints, targetSize)
	return offsetSegments(segs, block.startOffset), nil
}

// splitListBlock splits an oversized list block at item boundaries.
// Each list item starts with a bullet or number marker.
func splitListBlock(block structuralBlock, targetSize int) []textSegment {
	lines := strings.Split(block.text, "\n")
	var items []string
	var current []string

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			if len(current) > 0 {
				current = append(current, line)
			}
			continue
		}
		if reBullet.MatchString(trimmed) || reNumbered.MatchString(trimmed) {
			if len(current) > 0 {
				items = append(items, strings.TrimSpace(strings.Join(current, "\n")))
			}
			current = []string{line}
		} else {
			current = append(current, line)
		}
	}
	if len(current) > 0 {
		items = append(items, strings.TrimSpace(strings.Join(current, "\n")))
	}

	if len(items) <= 1 {
		return offsetSegments(splitRecursiveSegments(block.text, targetSize, targetSize/10), block.startOffset)
	}

	// Merge items into targetSize-sized segments.
	var segments []textSegment
	offset := block.startOffset
	var buf strings.Builder
	bufStart := offset

	for i, item := range items {
		itemLen := len([]rune(item))
		currentLen := len([]rune(buf.String()))

		if currentLen > 0 && currentLen+itemLen > targetSize {
			segments = append(segments, textSegment{
				text:        strings.TrimSpace(buf.String()),
				startOffset: bufStart,
				endOffset:   offset,
			})
			buf.Reset()
			bufStart = offset
		}
		buf.WriteString(item)
		if i < len(items)-1 {
			buf.WriteString("\n")
		}
		offset += len(item) + 1 // +1 for newline
	}
	if buf.Len() > 0 {
		segments = append(segments, textSegment{
			text:        strings.TrimSpace(buf.String()),
			startOffset: bufStart,
			endOffset:   block.endOffset,
		})
	}

	return segments
}

func offsetSegments(segs []textSegment, base int) []textSegment {
	for i := range segs {
		segs[i].startOffset += base
		segs[i].endOffset += base
	}
	return segs
}

func findSemanticBreakpoints(artifacts []ingestion.EmbeddingArtifact, threshold float64) []int {
	var breakpoints []int
	for i := 1; i < len(artifacts); i++ {
		sim, err := semanticCosine(artifacts[i-1].Vector, artifacts[i].Vector)
		if err != nil || sim < threshold {
			breakpoints = append(breakpoints, i)
		}
	}
	return breakpoints
}

func mergeSpans(spans []sentenceSpan, breakpoints []int, targetSize int) []textSegment {
	breakSet := make(map[int]bool)
	for _, b := range breakpoints {
		breakSet[b] = true
	}

	var segments []textSegment
	groupStart := 0
	var groupLen int

	for i := range spans {
		if breakSet[i] && groupLen > 0 {
			seg := buildSegment(spans, groupStart, i-1)
			segments = append(segments, seg)
			groupStart = i
			groupLen = 0
		}
		groupLen += len([]rune(spans[i].text))

		if targetSize > 0 && groupLen >= targetSize && i > groupStart {
			seg := buildSegment(spans, groupStart, i)
			segments = append(segments, seg)
			groupStart = i + 1
			groupLen = 0
		}
	}

	if groupStart < len(spans) {
		seg := buildSegment(spans, groupStart, len(spans)-1)
		segments = append(segments, seg)
	}

	return segments
}

func buildSegment(spans []sentenceSpan, start, end int) textSegment {
	var buf strings.Builder
	for i := start; i <= end; i++ {
		buf.WriteString(spans[i].text)
	}
	return textSegment{
		text:        strings.TrimSpace(buf.String()),
		startOffset: spans[start].startOffset,
		endOffset:   spans[end].endOffset,
	}
}

func semanticCosine(a, b []float32) (float64, error) {
	if len(a) != len(b) || len(a) == 0 {
		return 0, fmt.Errorf("dimension mismatch")
	}
	var dot, normA, normB float64
	for i := range a {
		va := float64(a[i])
		vb := float64(b[i])
		dot += va * vb
		normA += va * va
		normB += vb * vb
	}
	if normA == 0 || normB == 0 {
		return 0, nil
	}
	return dot / (math.Sqrt(normA) * math.Sqrt(normB)), nil
}

func hashSemantic(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
