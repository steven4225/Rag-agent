package openai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	provider "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/embedding/provider"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

const (
	ProviderName = "openai-compatible"
	DefaultModel = "text-embedding-3-small"
	SourceName   = "go-openai-compatible-embedding"
)

type Config struct {
	BaseURL   string
	APIKey    string
	Model     string
	Timeout   time.Duration
	UserAgent string
}

type Adapter struct {
	baseURL   string
	apiKey    string
	model     string
	client    *http.Client
	userAgent string
}

func NewAdapter(config Config) (*Adapter, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	apiKey := strings.TrimSpace(config.APIKey)
	if apiKey == "" {
		return nil, provider.AdapterError{
			Provider:  ProviderName,
			Model:     resolveModel(config.Model),
			Reason:    "provider-key-missing",
			Retryable: false,
			Err:       fmt.Errorf("EMBEDDING_API_KEY is required for provider %q", ProviderName),
		}
	}

	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	userAgent := strings.TrimSpace(config.UserAgent)
	if userAgent == "" {
		userAgent = "ragent-retrievalexecutor/openai-compatible"
	}

	return &Adapter{
		baseURL:   baseURL,
		apiKey:    apiKey,
		model:     resolveModel(config.Model),
		client:    &http.Client{Timeout: timeout},
		userAgent: userAgent,
	}, nil
}

type embeddingRequest struct {
	Model string   `json:"model"`
	Input []string `json:"input"`
}

type embeddingResponse struct {
	Data  []embeddingData `json:"data"`
	Model string          `json:"model"`
	Error *apiError       `json:"error,omitempty"`
}

type embeddingData struct {
	Index     int       `json:"index"`
	Embedding []float64 `json:"embedding"`
}

type apiError struct {
	Message string `json:"message"`
	Type    string `json:"type,omitempty"`
	Code    any    `json:"code,omitempty"`
}

func (a *Adapter) Embed(ctx context.Context, request ingestion.EmbeddingRequest) (ingestion.EmbeddingResult, error) {
	model := resolveModel(request.Model)
	if strings.TrimSpace(request.Model) == "" {
		model = a.model
	}

	textInputs := make([]string, 0, len(request.Inputs))
	for _, input := range request.Inputs {
		textInputs = append(textInputs, input.Text)
	}
	body, err := json.Marshal(embeddingRequest{
		Model: model,
		Input: textInputs,
	})
	if err != nil {
		return ingestion.EmbeddingResult{}, provider.AdapterError{
			Provider:  ProviderName,
			Model:     model,
			Reason:    "request-marshal-failed",
			Retryable: false,
			Err:       err,
		}
	}

	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+"/embeddings", bytes.NewReader(body))
	if err != nil {
		return ingestion.EmbeddingResult{}, provider.AdapterError{
			Provider:  ProviderName,
			Model:     model,
			Reason:    "request-build-failed",
			Retryable: false,
			Err:       err,
		}
	}
	httpRequest.Header.Set("Authorization", "Bearer "+a.apiKey)
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("User-Agent", a.userAgent)

	response, err := a.client.Do(httpRequest)
	if err != nil {
		return ingestion.EmbeddingResult{}, provider.AdapterError{
			Provider:  ProviderName,
			Model:     model,
			Reason:    "provider-request-failed",
			Retryable: true,
			Err:       err,
		}
	}
	defer response.Body.Close()

	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		return ingestion.EmbeddingResult{}, provider.AdapterError{
			Provider:  ProviderName,
			Model:     model,
			Reason:    "provider-response-read-failed",
			Retryable: true,
			Err:       err,
		}
	}

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		retryable := response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500
		return ingestion.EmbeddingResult{}, provider.AdapterError{
			Provider:  ProviderName,
			Model:     model,
			Reason:    "provider-http-error",
			Retryable: retryable,
			Err:       fmt.Errorf("status=%d body=%s", response.StatusCode, trimBody(responseBody)),
		}
	}

	var parsed embeddingResponse
	if err := json.Unmarshal(responseBody, &parsed); err != nil {
		return ingestion.EmbeddingResult{}, provider.AdapterError{
			Provider:  ProviderName,
			Model:     model,
			Reason:    "provider-response-parse-failed",
			Retryable: false,
			Err:       err,
		}
	}
	if parsed.Error != nil {
		return ingestion.EmbeddingResult{}, provider.AdapterError{
			Provider:  ProviderName,
			Model:     model,
			Reason:    "provider-api-error",
			Retryable: false,
			Err:       fmt.Errorf("%s", strings.TrimSpace(parsed.Error.Message)),
		}
	}
	if len(parsed.Data) != len(request.Inputs) {
		return ingestion.EmbeddingResult{}, provider.AdapterError{
			Provider:  ProviderName,
			Model:     model,
			Reason:    "provider-vector-count-mismatch",
			Retryable: false,
			Err:       fmt.Errorf("expected %d embeddings, got %d", len(request.Inputs), len(parsed.Data)),
		}
	}

	dataByIndex := make(map[int]embeddingData, len(parsed.Data))
	for _, item := range parsed.Data {
		dataByIndex[item.Index] = item
	}

	artifacts := make([]ingestion.EmbeddingArtifact, 0, len(request.Inputs))
	dimensions := 0
	for index, input := range request.Inputs {
		item, ok := dataByIndex[index]
		if !ok {
			return ingestion.EmbeddingResult{}, provider.AdapterError{
				Provider:  ProviderName,
				Model:     model,
				Reason:    "provider-vector-index-missing",
				Retryable: false,
				Err:       fmt.Errorf("missing embedding for input index %d", index),
			}
		}
		if dimensions == 0 {
			dimensions = len(item.Embedding)
		}
		if len(item.Embedding) != dimensions {
			return ingestion.EmbeddingResult{}, provider.AdapterError{
				Provider:  ProviderName,
				Model:     model,
				Reason:    "provider-dimension-mismatch",
				Retryable: false,
				Err:       fmt.Errorf("input index %d dimensions=%d expected=%d", index, len(item.Embedding), dimensions),
			}
		}

		vector := make([]float32, 0, len(item.Embedding))
		for _, value := range item.Embedding {
			vector = append(vector, float32(value))
		}
		artifacts = append(artifacts, ingestion.EmbeddingArtifact{
			ChunkID:      input.ChunkID,
			Vector:       vector,
			Dimensions:   len(vector),
			ContentHash:  input.ContentHash,
			EmbeddingRef: fmt.Sprintf("%s:%s:%s", ProviderName, model, input.ChunkID),
			Source:       SourceName,
			Metadata: map[string]any{
				"chunkIndex": input.ChunkIndex,
				"provider":   ProviderName,
			},
		})
	}

	return ingestion.EmbeddingResult{
		Status:      ingestion.StatusSucceeded,
		Model:       model,
		Source:      SourceName,
		VectorCount: len(artifacts),
		Dimensions:  dimensions,
		Artifacts:   artifacts,
		Metadata: map[string]any{
			"embeddingProvider": ProviderName,
			"embeddingModel":    model,
			"vectorDimensions":  dimensions,
			"inputCount":        len(request.Inputs),
		},
	}, nil
}

func resolveModel(value string) string {
	if strings.TrimSpace(value) == "" {
		return DefaultModel
	}
	return strings.TrimSpace(value)
}

func trimBody(body []byte) string {
	const limit = 300
	text := strings.TrimSpace(string(body))
	if len(text) <= limit {
		return text
	}
	return text[:limit]
}
