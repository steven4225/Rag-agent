package textchunker

import (
	"context"
	"strings"
	"testing"

	deterministicembedding "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/embedding/deterministic"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

func TestSplitStructuralEmpty(t *testing.T) {
	blocks := splitStructural("")
	if len(blocks) != 0 {
		t.Errorf("expected 0 blocks, got %d", len(blocks))
	}
}

func TestSplitStructuralSingleParagraph(t *testing.T) {
	text := "这是一段没有任何结构的纯文本。"
	blocks := splitStructural(text)
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(blocks))
	}
	if blocks[0].blockType != structParagraph {
		t.Errorf("expected structParagraph, got %v", blocks[0].blockType)
	}
	if blocks[0].text != text {
		t.Errorf("expected %q, got %q", text, blocks[0].text)
	}
	if blocks[0].startOffset != 0 || blocks[0].endOffset != len(text) {
		t.Errorf("offsets [%d:%d], expected [0:%d]", blocks[0].startOffset, blocks[0].endOffset, len(text))
	}
}

func TestSplitStructuralHeadings(t *testing.T) {
	text := "# 标题一\n这是第一段内容。\n\n## 标题二\n这是第二段内容。"
	blocks := splitStructural(text)
	if len(blocks) != 4 {
		t.Fatalf("expected 4 blocks, got %d", len(blocks))
	}
	if blocks[0].blockType != structHeading || blocks[0].text != "# 标题一" {
		t.Errorf("block 0: expected heading, got %v", blocks[0].blockType)
	}
	if blocks[1].blockType != structParagraph || blocks[1].text != "这是第一段内容。" {
		t.Errorf("block 1: expected paragraph, got %v", blocks[1].blockType)
	}
	if blocks[2].blockType != structHeading || blocks[2].text != "## 标题二" {
		t.Errorf("block 2: expected heading, got %v", blocks[2].blockType)
	}
	if blocks[3].blockType != structParagraph || blocks[3].text != "这是第二段内容。" {
		t.Errorf("block 3: expected paragraph, got %v", blocks[3].blockType)
	}
}

func TestSplitStructuralBulletList(t *testing.T) {
	text := "以下是要点：\n- 第一项\n- 第二项\n- 第三项\n这是结尾。"
	blocks := splitStructural(text)
	if len(blocks) != 3 {
		t.Fatalf("expected 3 blocks, got %d", len(blocks))
	}
	if blocks[0].blockType != structParagraph || blocks[0].text != "以下是要点：" {
		t.Errorf("block 0: got %v %q", blocks[0].blockType, blocks[0].text)
	}
	if blocks[1].blockType != structList {
		t.Errorf("block 1: expected list, got %v", blocks[1].blockType)
	}
	items := strings.Split(blocks[1].text, "\n")
	if len(items) != 3 {
		t.Errorf("expected 3 list items, got %d", len(items))
	}
	if blocks[2].blockType != structParagraph || blocks[2].text != "这是结尾。" {
		t.Errorf("block 2: got %v %q", blocks[2].blockType, blocks[2].text)
	}
}

func TestSplitStructuralNumberedList(t *testing.T) {
	text := "1. 第一步\n2. 第二步\n3. 第三步"
	blocks := splitStructural(text)
	if len(blocks) != 1 {
		t.Fatalf("expected 1 list block, got %d", len(blocks))
	}
	if blocks[0].blockType != structList {
		t.Errorf("expected structList, got %v", blocks[0].blockType)
	}
}

func TestSplitStructuralChineseNumbered(t *testing.T) {
	text := "一、项目背景\n二、实施计划\n三、预期成果"
	blocks := splitStructural(text)
	if len(blocks) != 1 {
		t.Fatalf("expected 1 list block, got %d", len(blocks))
	}
	if blocks[0].blockType != structList {
		t.Errorf("expected structList, got %v", blocks[0].blockType)
	}
}

func TestSplitStructuralQAPattern(t *testing.T) {
	text := "问：年假怎么申请？\n答：请在OA系统提交申请。"
	blocks := splitStructural(text)
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block (Q&A pair merged), got %d", len(blocks))
	}
	if blocks[0].blockType != structQA {
		t.Errorf("expected QA, got %v", blocks[0].blockType)
	}
	if !strings.Contains(blocks[0].text, "问：") || !strings.Contains(blocks[0].text, "答：") {
		t.Errorf("expected Q&A pair in one block, got %q", blocks[0].text)
	}
}

func TestSplitStructuralFAQ(t *testing.T) {
	text := "FAQ：为什么密码过期了？\n说明：每90天需要修改一次密码。"
	blocks := splitStructural(text)
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block (consecutive QA lines merged), got %d", len(blocks))
	}
	if blocks[0].blockType != structQA {
		t.Errorf("expected QA, got %v", blocks[0].blockType)
	}
}

func TestSplitStructuralCodeBlock(t *testing.T) {
	text := "下面是一段代码：\n```\nfunc main() {\n    fmt.Println(\"hello\")\n}\n```\n代码结束。"
	blocks := splitStructural(text)
	if len(blocks) < 3 {
		t.Fatalf("expected at least 3 blocks, got %d", len(blocks))
	}
	hasCode := false
	for _, b := range blocks {
		if b.blockType == structCode && strings.Contains(b.text, "func main()") {
			hasCode = true
		}
	}
	if !hasCode {
		t.Error("expected a code block containing func main()")
	}
}

func TestSplitStructuralDivider(t *testing.T) {
	text := "第一部分\n---\n第二部分"
	blocks := splitStructural(text)
	if len(blocks) != 3 {
		t.Fatalf("expected 3 blocks, got %d", len(blocks))
	}
	if blocks[1].blockType != structDivider {
		t.Errorf("expected divider, got %v", blocks[1].blockType)
	}
}

func TestSplitStructuralMixedEnglish(t *testing.T) {
	text := "## Overview\nThe leave policy requires manager approval.\n\n- Submit request 3 days in advance\n- HR responds within 24 hours\n\nNote: Emergency leave is handled separately."
	blocks := splitStructural(text)
	if len(blocks) < 4 {
		t.Fatalf("expected at least 4 blocks, got %d", len(blocks))
	}
	if blocks[0].blockType != structHeading {
		t.Errorf("block 0: expected heading, got %v", blocks[0].blockType)
	}
	if blocks[2].blockType != structList {
		t.Errorf("block 2: expected list, got %v", blocks[2].blockType)
	}
	if blocks[3].blockType != structQA { // Note: is detected as QA pattern
		t.Errorf("block 3: expected QA (Note prefix), got %v", blocks[3].blockType)
	}
}

func TestSplitStructuralOffsets(t *testing.T) {
	text := "# 标题\n正文内容。"
	blocks := splitStructural(text)
	if len(blocks) != 2 {
		t.Fatalf("expected 2 blocks, got %d", len(blocks))
	}
	// Verify offsets are within text bounds
	for i, b := range blocks {
		if b.startOffset < 0 || b.endOffset > len(text) {
			t.Errorf("block %d: offset [%d:%d] out of range [0:%d]", i, b.startOffset, b.endOffset, len(text))
		}
	}
	// First block (# 标题) should end at position after the heading + newline
	headingLen := len("# 标题\n")
	if blocks[0].endOffset != headingLen {
		t.Errorf("heading block: expected endOffset %d, got %d", headingLen, blocks[0].endOffset)
	}
	if blocks[1].startOffset != headingLen {
		t.Errorf("paragraph block: expected startOffset %d, got %d", headingLen, blocks[1].startOffset)
	}
}

func TestSemanticChunkerStructuralIntegration(t *testing.T) {
	adapter := deterministicembedding.NewAdapter()
	chunker := NewChunkerWithEmbedding(adapter)

	// Mixed document: headings + paragraphs + list
	text := "## 年假政策\n年假申请需要提前三天提交。\n\n## 病假政策\n病假需要提供医院证明。\n\n注意事项：\n- 病假超过3天需要HR审批\n- 紧急情况可后补证明"

	doc := ingestion.ParsedDocument{
		DocumentID: "doc-struct",
		Text:       text,
	}
	plan := ingestion.ChunkingExecutionPlan{
		Strategy:   "semantic",
		TargetSize: 1200,
	}

	chunks, _, err := chunker.Split(context.Background(), doc, plan)
	if err != nil {
		t.Fatalf("Split with structural semantic failed: %v", err)
	}
	if len(chunks) == 0 {
		t.Fatal("expected at least 1 chunk")
	}
	// Headings should produce their own chunks
	hasHeadingChunks := false
	for _, c := range chunks {
		if strings.Contains(c.Text, "##") {
			hasHeadingChunks = true
		}
	}
	if !hasHeadingChunks {
		t.Error("expected heading text preserved in chunks")
	}
	// Verify all chunks have metadata
	for i, c := range chunks {
		if c.ChunkID == "" {
			t.Errorf("chunk %d: missing ChunkID", i)
		}
		if c.ChunkIndex != i {
			t.Errorf("chunk %d: expected ChunkIndex %d, got %d", i, i, c.ChunkIndex)
		}
	}
}

func TestSemanticChunkerStructuralFallback(t *testing.T) {
	// No embedding adapter — structural should still work, falling back to recursive for long paras
	chunker := NewChunker()

	text := "# 标题\n这是一段普通的文本内容。"

	doc := ingestion.ParsedDocument{
		DocumentID: "doc-struct-noadapter",
		Text:       text,
	}
	plan := ingestion.ChunkingExecutionPlan{
		Strategy:   "semantic",
		TargetSize: 1200,
	}

	chunks, _, err := chunker.Split(context.Background(), doc, plan)
	if err != nil {
		t.Fatalf("Split failed: %v", err)
	}
	if len(chunks) != 2 {
		t.Errorf("expected 2 chunks (heading + paragraph), got %d", len(chunks))
	}
}
