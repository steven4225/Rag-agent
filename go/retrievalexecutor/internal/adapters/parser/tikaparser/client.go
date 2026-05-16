package tikaparser

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	parsererrors "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/parsererrors"
)

type httpClient interface {
	Do(req *http.Request) (*http.Response, error)
}

type Client struct {
	baseURL string
	http    httpClient
}

func NewClient(baseURL string, httpClient httpClient) *Client {
	return &Client{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		http:    httpClient,
	}
}

func (c *Client) ExtractText(ctx context.Context, mimeType string, payload []byte) (string, error) {
	body, err := c.do(ctx, "/tika", "text/plain", mimeType, payload)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(body)), nil
}

func (c *Client) ExtractMetadata(ctx context.Context, mimeType string, payload []byte) (map[string]any, error) {
	body, err := c.do(ctx, "/meta", "application/json", mimeType, payload)
	if err != nil {
		return nil, err
	}

	var metadata map[string]any
	if unmarshalErr := json.Unmarshal(body, &metadata); unmarshalErr == nil && metadata != nil {
		return metadata, nil
	}

	var list []map[string]any
	if unmarshalErr := json.Unmarshal(body, &list); unmarshalErr == nil && len(list) > 0 {
		return list[0], nil
	}

	return nil, parsererrors.ParseFailed(parserSource, "tika metadata response is not valid json object", nil)
}

func (c *Client) do(ctx context.Context, endpoint string, accept string, mimeType string, payload []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, c.baseURL+endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, parsererrors.ParseFailed(parserSource, "failed to build tika request", err)
	}
	if strings.TrimSpace(mimeType) == "" {
		req.Header.Set("Content-Type", "application/octet-stream")
	} else {
		req.Header.Set("Content-Type", strings.TrimSpace(mimeType))
	}
	req.Header.Set("Accept", accept)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, parsererrors.BackendUnavailable(parserSource, "failed to call tika backend", true, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, parsererrors.BackendUnavailable(parserSource, "failed to read tika response", true, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := fmt.Sprintf("tika endpoint %s returned status %d", endpoint, resp.StatusCode)
		if detail := strings.TrimSpace(string(body)); detail != "" {
			message = message + ": " + detail
		}
		return nil, parsererrors.BackendUnavailable(parserSource, message, isRetryableStatus(resp.StatusCode), nil)
	}
	return body, nil
}

func isRetryableStatus(statusCode int) bool {
	if statusCode == http.StatusTooManyRequests {
		return true
	}
	return statusCode >= 500 && statusCode <= 599
}
