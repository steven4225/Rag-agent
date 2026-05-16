package textparser

import (
	"context"
	"fmt"
	"strings"
	"time"

	parsererrors "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/parsererrors"
	parsersource "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/source"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

type Adapter struct{}

func NewAdapter() *Adapter {
	return &Adapter{}
}

func (a *Adapter) Parse(_ context.Context, request ingestion.ParseRequest) (ingestion.ParseResult, error) {
	start := time.Now()

	resolvedMimeType := parsersource.DetectKind(request.Source.MimeType, request.Source.Filename, request.Source.URI)
	if !supportsMimeType(resolvedMimeType) {
		return ingestion.ParseResult{}, parsererrors.UnsupportedFormat("parser-text", fmt.Sprintf("text parser does not support mime type %s", resolvedMimeType), nil)
	}

	content, sourceScheme, err := parsersource.ReadSourceText(request.Source.URI, "parser-text")
	if err != nil {
		return ingestion.ParseResult{}, err
	}

	normalized := parsersource.NormalizeLineEndings(content)
	if strings.TrimSpace(normalized) == "" {
		return ingestion.ParseResult{}, parsererrors.ParseFailed("parser-text", "parsed document is empty", nil)
	}

	title := parsersource.FallbackTitle(request.Source.Filename, "Untitled text document")
	var sections []ingestion.ParsedSection
	if resolvedMimeType == parsersource.KindMarkdown {
		title, sections = parseMarkdownSections(normalized, title)
	} else {
		title, sections = parsePlainTextSections(normalized, title)
	}

	document := &ingestion.ParsedDocument{
		DocumentID: request.DocumentID,
		Title:      title,
		MimeType:   resolvedMimeType,
		Language:   "",
		CharCount:  len(normalized),
		PageCount:  nil,
		Metadata: map[string]any{
			"sourceScheme": sourceScheme,
			"parserType":   request.Plan.Parser.ParserType,
		},
		Text:     normalized,
		Sections: sections,
	}

	return ingestion.ParseResult{
		ParserBackend:  "text",
		ParserName:     "go-text-parser",
		ParserVersion:  "minimal-loop-v1",
		Status:         ingestion.StatusSucceeded,
		Warnings:       buildWarnings(sourceScheme, resolvedMimeType),
		ParsedDocument: document,
		Metrics: ingestion.ParserMetrics{
			ParseDurationMs: time.Since(start).Milliseconds(),
		},
	}, nil
}

func supportsMimeType(mimeType string) bool {
	switch mimeType {
	case parsersource.KindPlainText, parsersource.KindMarkdown:
		return true
	default:
		return false
	}
}

func parsePlainTextSections(content, fallbackTitle string) (string, []ingestion.ParsedSection) {
	title := fallbackTitle
	lines := strings.Split(content, "\n")
	for _, line := range lines {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			if title == "" {
				title = trimmed
			}
			break
		}
	}
	if title == "" {
		title = "Untitled text document"
	}

	return title, []ingestion.ParsedSection{
		{
			SectionID:   "section-1",
			Title:       title,
			Level:       1,
			Text:        content,
			StartOffset: 0,
			EndOffset:   len(content),
		},
	}
}

func parseMarkdownSections(content, fallbackTitle string) (string, []ingestion.ParsedSection) {
	lines := strings.Split(content, "\n")
	type heading struct {
		index int
		title string
		level int
	}

	headings := make([]heading, 0)
	offset := 0
	title := fallbackTitle

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") {
			level := countHeadingLevel(trimmed)
			headingTitle := strings.TrimSpace(trimmed[level:])
			if headingTitle != "" {
				headings = append(headings, heading{
					index: offset,
					title: headingTitle,
					level: level,
				})
				if len(headings) == 1 {
					title = headingTitle
				}
			}
		}
		offset += len(line) + 1
	}

	if title == "" {
		title = "Untitled markdown document"
	}

	if len(headings) == 0 {
		return parsePlainTextSections(content, title)
	}

	sections := make([]ingestion.ParsedSection, 0, len(headings))
	for index, item := range headings {
		start := item.index
		end := len(content)
		if index+1 < len(headings) {
			end = headings[index+1].index
		}
		sectionText := strings.TrimSpace(content[start:end])
		sections = append(sections, ingestion.ParsedSection{
			SectionID:   fmt.Sprintf("section-%d", index+1),
			Title:       item.title,
			Level:       item.level,
			Text:        sectionText,
			StartOffset: start,
			EndOffset:   end,
		})
	}

	return title, sections
}

func countHeadingLevel(line string) int {
	level := 0
	for _, char := range line {
		if char != '#' {
			break
		}
		level++
	}
	if level == 0 {
		return 1
	}
	return level
}

func buildWarnings(sourceScheme, mimeType string) []string {
	warnings := make([]string, 0, 1)
	if sourceScheme == "data" {
		warnings = append(warnings, "data URI source is intended for local minimal-loop validation, not production ingestion storage")
	}
	if mimeType == parsersource.KindPlainText {
		return warnings
	}
	return warnings
}
