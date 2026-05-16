package textchunker

import (
	"context"
	"strings"
	"testing"

	deterministicembedding "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/embedding/deterministic"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

func TestSplitSentencesChinese(t *testing.T) {
	text := "今天天气很好。我们出去走走吧！你同意吗？\n新的一段。"
	spans := splitSentences(text)
	if len(spans) != 4 {
		t.Fatalf("expected 4 sentences, got %d", len(spans))
	}
	expected := []string{"今天天气很好。", "我们出去走走吧！", "你同意吗？", "新的一段。"}
	for i, exp := range expected {
		if spans[i].text != exp {
			t.Errorf("sentence %d: expected %q, got %q", i, exp, spans[i].text)
		}
	}
}

func TestSplitSentencesEmpty(t *testing.T) {
	spans := splitSentences("")
	if len(spans) != 0 {
		t.Errorf("expected 0 sentences, got %d", len(spans))
	}
}

func TestSplitSentencesSingle(t *testing.T) {
	spans := splitSentences("No punctuation at all")
	if len(spans) != 1 {
		t.Fatalf("expected 1 sentence, got %d", len(spans))
	}
	if spans[0].text != "No punctuation at all" {
		t.Errorf("got %q", spans[0].text)
	}
}

func TestSplitSentencesOffsets(t *testing.T) {
	text := "第一句。第二句。"
	spans := splitSentences(text)
	if len(spans) != 2 {
		t.Fatalf("expected 2 sentences, got %d", len(spans))
	}
	// Verify offsets cover the original text
	for i, sp := range spans {
		if sp.startOffset < 0 || sp.endOffset > len(text) {
			t.Errorf("sentence %d: offset [%d:%d] out of range [0:%d]", i, sp.startOffset, sp.endOffset, len(text))
		}
	}
	// First sentence should start at 0
	if spans[0].startOffset != 0 {
		t.Errorf("expected first offset 0, got %d", spans[0].startOffset)
	}
}

func TestSemanticCosineIdentical(t *testing.T) {
	v := []float32{1.0, 2.0, 3.0}
	sim, err := semanticCosine(v, v)
	if err != nil {
		t.Fatal(err)
	}
	if sim < 0.9999 {
		t.Errorf("expected 1.0, got %f", sim)
	}
}

func TestSemanticCosineOrthogonal(t *testing.T) {
	a := []float32{1.0, 0.0, 0.0}
	b := []float32{0.0, 1.0, 0.0}
	sim, err := semanticCosine(a, b)
	if err != nil {
		t.Fatal(err)
	}
	if sim > 0.0001 {
		t.Errorf("expected ~0, got %f", sim)
	}
}

func TestSemanticCosineDimensionMismatch(t *testing.T) {
	_, err := semanticCosine([]float32{1.0}, []float32{1.0, 2.0})
	if err == nil {
		t.Error("expected error for dimension mismatch")
	}
}

func TestSemanticCosineZeroVectors(t *testing.T) {
	sim, err := semanticCosine([]float32{0.0, 0.0}, []float32{0.0, 0.0})
	if err != nil {
		t.Fatal(err)
	}
	if sim != 0 {
		t.Errorf("expected 0 for zero vectors, got %f", sim)
	}
}

func TestMergeSpansBasic(t *testing.T) {
	spans := []sentenceSpan{
		{text: "A。", startOffset: 0, endOffset: 3},
		{text: "B。", startOffset: 3, endOffset: 6},
		{text: "C。", startOffset: 6, endOffset: 9},
	}
	// No breakpoints — all merged into one segment
	segments := mergeSpans(spans, nil, 0)
	if len(segments) != 1 {
		t.Fatalf("expected 1 segment, got %d", len(segments))
	}
	if segments[0].text != "A。B。C。" {
		t.Errorf("got %q", segments[0].text)
	}
	if segments[0].startOffset != 0 || segments[0].endOffset != 9 {
		t.Errorf("got offsets [%d:%d]", segments[0].startOffset, segments[0].endOffset)
	}
}

func TestMergeSpansWithBreakpoints(t *testing.T) {
	spans := []sentenceSpan{
		{text: "A。", startOffset: 0, endOffset: 3},
		{text: "B。", startOffset: 3, endOffset: 6},
		{text: "C。", startOffset: 6, endOffset: 9},
	}
	// Breakpoint at index 2 (between B and C)
	segments := mergeSpans(spans, []int{2}, 0)
	if len(segments) != 2 {
		t.Fatalf("expected 2 segments, got %d", len(segments))
	}
	if segments[0].text != "A。B。" {
		t.Errorf("first segment got %q", segments[0].text)
	}
	if segments[1].text != "C。" {
		t.Errorf("second segment got %q", segments[1].text)
	}
}

func TestMergeSpansTargetSize(t *testing.T) {
	spans := []sentenceSpan{
		{text: strings.Repeat("A", 50), startOffset: 0, endOffset: 50},
		{text: strings.Repeat("B", 50), startOffset: 50, endOffset: 100},
		{text: strings.Repeat("C", 50), startOffset: 100, endOffset: 150},
		{text: strings.Repeat("D", 50), startOffset: 150, endOffset: 200},
	}
	// Target size 120 chars — first 3 sentences = 150 > 120, so split at 2
	segments := mergeSpans(spans, nil, 120)
	if len(segments) < 2 {
		t.Fatalf("expected at least 2 segments due to target size, got %d", len(segments))
	}
}

func TestSemanticSegmentsIntegration(t *testing.T) {
	adapter := deterministicembedding.NewAdapter()
	chunker := NewChunkerWithEmbedding(adapter)

	// Text with clear topic shift after 2nd sentence
	text := "休假政策规定员工每年享有带薪年假。年假天数根据工龄计算。" +
		"工资发放日期为每月二十五号。如遇节假日则提前发放。"

	doc := ingestion.ParsedDocument{
		DocumentID: "doc-1",
		Text:       text,
	}

	segments, err := chunker.semanticSegments(context.Background(), doc, 1200)
	if err != nil {
		t.Fatalf("semanticSegments failed: %v", err)
	}
	if len(segments) == 0 {
		t.Fatal("expected at least 1 segment")
	}
	if len(segments) < 2 {
		t.Logf("warning: semantic chunker didn't split topics (got %d segments)", len(segments))
	}
	// Verify offsets are within range
	for i, seg := range segments {
		if seg.startOffset < 0 || seg.endOffset > len(text) {
			t.Errorf("segment %d: offset [%d:%d] out of range", i, seg.startOffset, seg.endOffset)
		}
	}
}

func TestSemanticSegmentsTooFew(t *testing.T) {
	adapter := deterministicembedding.NewAdapter()
	chunker := NewChunkerWithEmbedding(adapter)

	text := "只有一句话的内容。"
	doc := ingestion.ParsedDocument{
		DocumentID: "doc-1",
		Text:       text,
	}

	// Single-sentence documents are valid: the structural pass treats them
	// as a single short paragraph and bypasses embedding entirely.
	segments, err := chunker.semanticSegments(context.Background(), doc, 1200)
	if err != nil {
		t.Fatalf("semanticSegments failed: %v", err)
	}
	if len(segments) != 1 {
		t.Errorf("expected 1 segment for single sentence, got %d", len(segments))
	}
	if segments[0].text != text {
		t.Errorf("expected segment text %q, got %q", text, segments[0].text)
	}
}

func TestSplitSemanticStrategy(t *testing.T) {
	adapter := deterministicembedding.NewAdapter()
	chunker := NewChunkerWithEmbedding(adapter)

	text := "第一段内容在这里。这是关于主题A的讨论。" +
		"完全不同的主题B出现了。这里讨论另一个方向。"

	doc := ingestion.ParsedDocument{
		DocumentID: "doc-semantic",
		Text:       text,
	}
	plan := ingestion.ChunkingExecutionPlan{
		Strategy:   "semantic",
		TargetSize: 500,
	}

	chunks, elapsedMs, err := chunker.Split(context.Background(), doc, plan)
	if err != nil {
		t.Fatalf("Split with semantic strategy failed: %v", err)
	}
	if len(chunks) == 0 {
		t.Fatal("expected at least 1 chunk")
	}
	if elapsedMs < 0 {
		t.Error("expected non-negative elapsed time")
	}
	// Every chunk should have metadata
	for i, c := range chunks {
		if c.ChunkID == "" {
			t.Errorf("chunk %d: missing ChunkID", i)
		}
		if c.DocumentID != "doc-semantic" {
			t.Errorf("chunk %d: expected DocumentID doc-semantic, got %s", i, c.DocumentID)
		}
	}
}

func TestSplitSemanticFallbackNoAdapter(t *testing.T) {
	chunker := NewChunker() // no embedding adapter

	text := "段落一的内容在这里。\n\n段落二的内容在这里。"
	doc := ingestion.ParsedDocument{
		DocumentID: "doc-fallback",
		Text:       text,
	}
	plan := ingestion.ChunkingExecutionPlan{
		Strategy:   "semantic",
		TargetSize: 1200,
	}

	chunks, _, err := chunker.Split(context.Background(), doc, plan)
	if err != nil {
		t.Fatalf("Split with semantic fallback failed: %v", err)
	}
	// Should fall back to paragraph splitting
	if len(chunks) != 2 {
		t.Errorf("expected 2 paragraph chunks from fallback, got %d", len(chunks))
	}
}

func TestSplitSemanticEmptyDocument(t *testing.T) {
	adapter := deterministicembedding.NewAdapter()
	chunker := NewChunkerWithEmbedding(adapter)

	doc := ingestion.ParsedDocument{
		DocumentID: "doc-empty",
		Text:       "",
	}
	plan := ingestion.ChunkingExecutionPlan{
		Strategy:   "semantic",
		TargetSize: 1200,
	}

	_, _, err := chunker.Split(context.Background(), doc, plan)
	if err != ErrEmptyChunkSource {
		t.Errorf("expected ErrEmptyChunkSource, got %v", err)
	}
}

func TestFindSemanticBreakpoints(t *testing.T) {
	// Create artifacts with known vectors
	artifacts := []ingestion.EmbeddingArtifact{
		{Vector: []float32{1.0, 0.0, 0.0}}, // sentence 0: topic A
		{Vector: []float32{0.9, 0.1, 0.0}}, // sentence 1: similar to A → no break
		{Vector: []float32{0.0, 1.0, 0.0}}, // sentence 2: very different → break
		{Vector: []float32{0.0, 0.9, 0.1}}, // sentence 3: similar to 2 → no break
	}

	breakpoints := findSemanticBreakpoints(artifacts, 0.6)
	// Expect break at index 2 (between sentence 1 and 2)
	if len(breakpoints) != 1 || breakpoints[0] != 2 {
		t.Errorf("expected breakpoint at [2], got %v", breakpoints)
	}
}

func TestSplitSemanticDocumentPreservesChunkIndex(t *testing.T) {
	adapter := deterministicembedding.NewAdapter()
	chunker := NewChunkerWithEmbedding(adapter)

	text := "第一句。第二句。第三句。第四句。第五句。第六句。"
	doc := ingestion.ParsedDocument{DocumentID: "doc-idx", Text: text}
	plan := ingestion.ChunkingExecutionPlan{Strategy: "semantic", TargetSize: 1200}

	chunks, _, err := chunker.Split(context.Background(), doc, plan)
	if err != nil {
		t.Fatal(err)
	}
	for i, c := range chunks {
		if c.ChunkIndex != i {
			t.Errorf("chunk %d: expected ChunkIndex %d, got %d", i, i, c.ChunkIndex)
		}
	}
}

func TestSplitSemanticStrategyWithEnglishText(t *testing.T) {
	adapter := deterministicembedding.NewAdapter()
	chunker := NewChunkerWithEmbedding(adapter)

	// English text with newlines as sentence boundaries
	text := "The company leave policy allows 15 days per year.\n" +
		"Employees must submit requests two weeks in advance.\n" +
		"Payroll processing occurs on the 25th of each month.\n" +
		"Late submissions will be processed in the following cycle."

	doc := ingestion.ParsedDocument{DocumentID: "doc-en", Text: text}
	plan := ingestion.ChunkingExecutionPlan{Strategy: "semantic", TargetSize: 1200}

	chunks, _, err := chunker.Split(context.Background(), doc, plan)
	if err != nil {
		t.Fatal(err)
	}
	if len(chunks) == 0 {
		t.Fatal("expected at least 1 chunk")
	}
}
