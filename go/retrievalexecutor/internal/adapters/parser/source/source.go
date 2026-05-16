package source

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	parsererrors "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/parsererrors"
)

const (
	KindPlainText = "text/plain"
	KindMarkdown  = "text/markdown"
	KindPDF       = "application/pdf"
	KindDOCX      = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)

func DetectKind(mimeType, filename, rawURI string) string {
	normalizedMime := strings.ToLower(strings.TrimSpace(mimeType))
	switch normalizedMime {
	case KindPlainText, KindMarkdown, KindPDF, KindDOCX:
		return normalizedMime
	}

	lowerName := strings.ToLower(strings.TrimSpace(filename))
	switch {
	case strings.HasSuffix(lowerName, ".md"), strings.HasSuffix(lowerName, ".markdown"):
		return KindMarkdown
	case strings.HasSuffix(lowerName, ".txt"):
		return KindPlainText
	case strings.HasSuffix(lowerName, ".pdf"):
		return KindPDF
	case strings.HasSuffix(lowerName, ".docx"):
		return KindDOCX
	}

	lowerURI := strings.ToLower(strings.TrimSpace(rawURI))
	switch {
	case strings.HasPrefix(lowerURI, "data:text/markdown"):
		return KindMarkdown
	case strings.HasPrefix(lowerURI, "data:text/plain"):
		return KindPlainText
	case strings.HasPrefix(lowerURI, "data:application/pdf"):
		return KindPDF
	case strings.HasPrefix(lowerURI, "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document"):
		return KindDOCX
	default:
		return KindPlainText
	}
}

func ReadSourceText(rawURI string, errorSource string) (string, string, error) {
	bytes, sourceScheme, err := ReadSourceBytes(rawURI, errorSource)
	if err != nil {
		return "", sourceScheme, err
	}
	return string(bytes), sourceScheme, nil
}

func ReadSourceBytes(rawURI string, errorSource string) ([]byte, string, error) {
	trimmed := strings.TrimSpace(rawURI)
	if strings.HasPrefix(strings.ToLower(trimmed), "data:") {
		content, err := readDataURI(trimmed)
		if err != nil {
			return nil, "data", parsererrors.FileReadFailed(errorSource, "failed to decode data URI", false, err)
		}
		return content, "data", nil
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return nil, "", parsererrors.FileReadFailed(errorSource, "failed to parse source URI", false, err)
	}

	switch parsed.Scheme {
	case "file":
		path := resolveFilePath(parsed)
		if strings.TrimSpace(path) == "" {
			return nil, "file", parsererrors.FileReadFailed(errorSource, "file URI path is empty", false, nil)
		}
		bytes, readErr := os.ReadFile(path)
		if readErr != nil {
			retryable := os.IsTimeout(readErr) || os.IsNotExist(readErr)
			return nil, "file", parsererrors.FileReadFailed(errorSource, fmt.Sprintf("failed to read file %s", path), retryable, readErr)
		}
		return bytes, "file", nil
	default:
		return nil, parsed.Scheme, parsererrors.ParseFailed(errorSource, fmt.Sprintf("unsupported source URI scheme: %s", parsed.Scheme), nil)
	}
}

func resolveFilePath(parsed *url.URL) string {
	path := parsed.Path
	if path == "" && parsed.Host != "" {
		path = parsed.Host
	}
	if path != "" && parsed.Host != "" && !strings.HasPrefix(path, parsed.Host) && !strings.Contains(path, ":") {
		path = "//" + parsed.Host + path
	}
	if path == "" {
		path = parsed.Opaque
	}
	if len(path) >= 3 && path[0] == '/' && path[2] == ':' {
		path = path[1:]
	}
	return filepath.FromSlash(path)
}

func readDataURI(rawURI string) ([]byte, error) {
	body := strings.TrimPrefix(rawURI, "data:")
	commaIndex := strings.Index(body, ",")
	if commaIndex < 0 {
		return nil, fmt.Errorf("invalid data URI payload")
	}

	meta := body[:commaIndex]
	payload := body[commaIndex+1:]
	if strings.HasSuffix(meta, ";base64") {
		return base64.StdEncoding.DecodeString(payload)
	}

	decoded, err := url.QueryUnescape(payload)
	if err != nil {
		return nil, err
	}
	return []byte(decoded), nil
}

func NormalizeLineEndings(content string) string {
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	return strings.TrimSpace(normalized)
}

func FallbackTitle(filename string, fallback string) string {
	base := strings.TrimSpace(filepath.Base(filename))
	ext := strings.TrimSpace(filepath.Ext(base))
	if base != "" && ext != "" {
		base = strings.TrimSpace(strings.TrimSuffix(base, ext))
	}
	if base != "" {
		return base
	}
	return fallback
}
