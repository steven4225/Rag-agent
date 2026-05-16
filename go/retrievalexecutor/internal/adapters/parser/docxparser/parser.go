package docxparser

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"strings"
	"time"

	parsererrors "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/parsererrors"
	parsersource "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/source"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

const parserSource = "parser-docx"

type Adapter struct{}

func NewAdapter() *Adapter {
	return &Adapter{}
}

func (a *Adapter) Parse(_ context.Context, request ingestion.ParseRequest) (ingestion.ParseResult, error) {
	start := time.Now()
	resolvedMimeType := parsersource.DetectKind(request.Source.MimeType, request.Source.Filename, request.Source.URI)
	if resolvedMimeType != parsersource.KindDOCX {
		return ingestion.ParseResult{}, parsererrors.UnsupportedFormat(parserSource, fmt.Sprintf("docx parser does not support mime type %s", resolvedMimeType), nil)
	}

	contentBytes, sourceScheme, err := parsersource.ReadSourceBytes(request.Source.URI, parserSource)
	if err != nil {
		return ingestion.ParseResult{}, err
	}
	if len(contentBytes) == 0 {
		return ingestion.ParseResult{}, parsererrors.ParseFailed(parserSource, "parsed document is empty", nil)
	}

	archive, err := zip.NewReader(bytes.NewReader(contentBytes), int64(len(contentBytes)))
	if err != nil {
		return ingestion.ParseResult{}, parsererrors.ParseFailed(parserSource, "failed to open docx zip archive", err)
	}

	documentXML, err := readZipEntry(archive, "word/document.xml")
	if err != nil {
		return ingestion.ParseResult{}, parsererrors.ParseFailed(parserSource, "missing word/document.xml in docx archive", err)
	}

	paragraphs, err := extractParagraphs(documentXML)
	if err != nil {
		return ingestion.ParseResult{}, parsererrors.ParseFailed(parserSource, "failed to parse word/document.xml", err)
	}
	text := parsersource.NormalizeLineEndings(strings.Join(paragraphs, "\n\n"))
	if text == "" {
		return ingestion.ParseResult{}, parsererrors.ParseFailed(parserSource, "docx parser returned empty text output", nil)
	}

	docxTitle := ""
	coreXML, coreErr := readZipEntry(archive, "docProps/core.xml")
	if coreErr == nil {
		docxTitle, _ = extractCoreTitle(coreXML)
	}
	title := strings.TrimSpace(docxTitle)
	if title == "" {
		title = parsersource.FallbackTitle(request.Source.Filename, "Untitled docx document")
	}

	sections := []ingestion.ParsedSection{
		{
			SectionID:   "section-1",
			Title:       title,
			Level:       1,
			Text:        text,
			StartOffset: 0,
			EndOffset:   len(text),
		},
	}
	document := &ingestion.ParsedDocument{
		DocumentID: request.DocumentID,
		Title:      title,
		MimeType:   parsersource.KindDOCX,
		Language:   "",
		CharCount:  len(text),
		PageCount:  nil,
		Metadata: map[string]any{
			"sourceScheme": sourceScheme,
			"parserType":   request.Plan.Parser.ParserType,
		},
		Text:     text,
		Sections: sections,
	}

	return ingestion.ParseResult{
		ParserBackend: "simple",
		ParserName:    "go-docx-parser",
		ParserVersion: "phase1",
		Status:        ingestion.StatusSucceeded,
		Warnings: []string{
			"DOCX parser phase 1 extracts plain text paragraphs only, without table/layout fidelity.",
		},
		ParsedDocument: document,
		Metrics: ingestion.ParserMetrics{
			ParseDurationMs: time.Since(start).Milliseconds(),
		},
	}, nil
}

func readZipEntry(archive *zip.Reader, entryName string) ([]byte, error) {
	for _, file := range archive.File {
		if file.Name != entryName {
			continue
		}
		reader, err := file.Open()
		if err != nil {
			return nil, err
		}
		defer reader.Close()
		return io.ReadAll(reader)
	}
	return nil, fmt.Errorf("entry not found: %s", entryName)
}

func extractParagraphs(documentXML []byte) ([]string, error) {
	decoder := xml.NewDecoder(bytes.NewReader(documentXML))
	paragraphs := make([]string, 0, 8)
	var current strings.Builder

	for {
		token, err := decoder.Token()
		if err != nil {
			if err == io.EOF {
				break
			}
			return nil, err
		}

		switch typed := token.(type) {
		case xml.StartElement:
			switch typed.Name.Local {
			case "t":
				var textValue string
				if decodeErr := decoder.DecodeElement(&textValue, &typed); decodeErr != nil {
					return nil, decodeErr
				}
				current.WriteString(textValue)
			case "tab":
				current.WriteByte('\t')
			case "br", "cr":
				current.WriteByte('\n')
			}
		case xml.EndElement:
			if typed.Name.Local == "p" {
				paragraph := strings.TrimSpace(current.String())
				if paragraph != "" {
					paragraphs = append(paragraphs, paragraph)
				}
				current.Reset()
			}
		}
	}

	return paragraphs, nil
}

func extractCoreTitle(coreXML []byte) (string, error) {
	decoder := xml.NewDecoder(bytes.NewReader(coreXML))
	for {
		token, err := decoder.Token()
		if err != nil {
			if err == io.EOF {
				return "", nil
			}
			return "", err
		}
		startElement, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		if strings.EqualFold(startElement.Name.Local, "title") {
			var title string
			if decodeErr := decoder.DecodeElement(&title, &startElement); decodeErr != nil {
				return "", decodeErr
			}
			return strings.TrimSpace(title), nil
		}
	}
}
