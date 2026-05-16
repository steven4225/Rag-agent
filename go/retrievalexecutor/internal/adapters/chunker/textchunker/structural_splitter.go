package textchunker

import (
	"regexp"
	"strings"
)

type structuralType int

const (
	structParagraph structuralType = iota
	structHeading
	structList
	structCode
	structQA
	structDivider
)

type structuralBlock struct {
	text        string
	blockType   structuralType
	startOffset int
	endOffset   int
}

var (
	reHeading  = regexp.MustCompile(`^#{1,6}\s+\S`)
	reNumbered = regexp.MustCompile(`^\s*(?:\d+[\.\)、]|[(（]\d+[)）]|[①②③④⑤⑥⑦⑧⑨⑩]|[一二三四五六七八九十]+[、.）\)])`)
	reBullet   = regexp.MustCompile(`^\s*[-*•·]\s+\S`)
	reQAPrefix = regexp.MustCompile(`^\s*(?:Q|A|问|答|FAQ|注意|说明|提示|警告|Note|Tip|Warning|Important)[：:]\s*\S`)
	reDivider  = regexp.MustCompile(`^(?:\-{3,}|\*{3,}|_{3,})\s*$`)
)

// splitStructural splits text into typed structural blocks.
// Headings, lists, Q&A markers, code fences, and dividers create block
// boundaries. Adjacent paragraphs merge into a single block.
// Byte offsets track position in the original text for section-path
// resolution downstream.
func splitStructural(text string) []structuralBlock {
	lines := strings.Split(text, "\n")
	if len(lines) == 0 {
		return nil
	}

	var blocks []structuralBlock
	var currentLines []string
	currentType := structParagraph
	byteCursor := 0
	blockStart := 0
	inCodeBlock := false

	flush := func() {
		content := strings.TrimSpace(strings.Join(currentLines, "\n"))
		if content == "" {
			currentLines = nil
			return
		}
		blocks = append(blocks, structuralBlock{
			text:        content,
			blockType:   currentType,
			startOffset: blockStart,
			endOffset:   byteCursor,
		})
		currentLines = nil
	}

	for i, line := range lines {
		lineLen := len(line)
		if i < len(lines)-1 {
			lineLen++ // \n separator
		}

		// Code fence toggles
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			if !inCodeBlock {
				flush()
				inCodeBlock = true
				currentType = structCode
				blockStart = byteCursor
			} else {
				currentLines = append(currentLines, line)
				byteCursor += lineLen
				flush()
				inCodeBlock = false
				currentType = structParagraph
				blockStart = byteCursor
				continue
			}
			currentLines = append(currentLines, line)
			byteCursor += lineLen
			continue
		}

		if inCodeBlock {
			currentLines = append(currentLines, line)
			byteCursor += lineLen
			continue
		}

		lineType := classifyLine(trimmed)

		// Empty lines separate paragraph blocks but are preserved as
		// spacing inside structured blocks (lists, code).
		if trimmed == "" {
			if currentType == structParagraph && len(currentLines) > 0 {
				flush()
				blockStart = byteCursor + lineLen
			} else if len(currentLines) > 0 {
				currentLines = append(currentLines, line)
			}
			byteCursor += lineLen
			continue
		}

		// Same category: accumulate
		if lineType == currentType && lineType != structHeading && lineType != structDivider {
			currentLines = append(currentLines, line)
			byteCursor += lineLen
			continue
		}

		// Different type or standalone element (heading, divider always standalone)
		if len(currentLines) > 0 {
			flush()
		}
		currentType = lineType
		blockStart = byteCursor
		currentLines = append(currentLines, line)
		byteCursor += lineLen
	}

	// Handle unclosed code fence
	if inCodeBlock && len(currentLines) > 0 {
		flush()
	} else if !inCodeBlock && len(currentLines) > 0 {
		flush()
	}

	return blocks
}

func classifyLine(line string) structuralType {
	if line == "" {
		return structParagraph
	}
	if reHeading.MatchString(line) {
		return structHeading
	}
	if reQAPrefix.MatchString(line) {
		return structQA
	}
	if reDivider.MatchString(line) {
		return structDivider
	}
	if reNumbered.MatchString(line) {
		return structList
	}
	if reBullet.MatchString(line) {
		return structList
	}
	return structParagraph
}
