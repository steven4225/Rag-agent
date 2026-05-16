package docxparser

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"testing"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

func TestParseDOCXDataURI(t *testing.T) {
	content := buildDOCXFixture(t)
	adapter := NewAdapter()

	result, err := adapter.Parse(context.Background(), ingestion.ParseRequest{
		DocumentID: "doc-1",
		Plan: ingestion.ExecutionPlan{
			Parser: ingestion.ParserExecutionPlan{
				ParserType: "auto",
			},
		},
		Source: ingestion.Source{
			Filename: "sample.docx",
			MimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			URI:      "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64," + base64.StdEncoding.EncodeToString(content),
		},
	})
	if err != nil {
		t.Fatalf("expected no parse error, got %v", err)
	}
	if result.ParserName != "go-docx-parser" {
		t.Fatalf("expected go-docx-parser, got %s", result.ParserName)
	}
	if result.ParsedDocument == nil {
		t.Fatalf("expected parsed document")
	}
	if result.ParsedDocument.Title != "Sample DOCX Title" {
		t.Fatalf("expected core.xml title, got %s", result.ParsedDocument.Title)
	}
	if result.ParsedDocument.CharCount == 0 {
		t.Fatalf("expected char count > 0")
	}
	if len(result.ParsedDocument.Sections) == 0 {
		t.Fatalf("expected parsed sections")
	}
}

func buildDOCXFixture(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)

	documentXML := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
	<w:body>
		<w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p>
		<w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p>
	</w:body>
</w:document>`

	coreXML := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
	<dc:title>Sample DOCX Title</dc:title>
</cp:coreProperties>`

	writeEntry := func(name string, data string) {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatalf("failed to create zip entry %s: %v", name, err)
		}
		if _, err := file.Write([]byte(data)); err != nil {
			t.Fatalf("failed to write zip entry %s: %v", name, err)
		}
	}
	writeEntry("word/document.xml", documentXML)
	writeEntry("docProps/core.xml", coreXML)

	if err := writer.Close(); err != nil {
		t.Fatalf("failed to close zip writer: %v", err)
	}
	return buffer.Bytes()
}
