package resolver

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	deterministic "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/embedding/deterministic"
	provider "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/embedding/provider"
	openai "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/embedding/provider/openai"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

const (
	ProviderDeterministic    = "deterministic"
	ProviderOpenAICompatible = "openai-compatible"
)

type Config struct {
	Provider        string
	Model           string
	APIKey          string
	BaseURL         string
	FallbackEnabled bool
	Timeout         time.Duration
}

func ResolveFromEnv() ingestion.EmbeddingAdapter {
	config := Config{
		Provider:        strings.TrimSpace(os.Getenv("EMBEDDING_PROVIDER")),
		Model:           strings.TrimSpace(os.Getenv("EMBEDDING_MODEL")),
		APIKey:          strings.TrimSpace(os.Getenv("EMBEDDING_API_KEY")),
		BaseURL:         strings.TrimSpace(os.Getenv("EMBEDDING_BASE_URL")),
		FallbackEnabled: parseBool(os.Getenv("EMBEDDING_FALLBACK_ENABLED"), true),
		Timeout:         readTimeout("EMBEDDING_TIMEOUT_MS", 15*time.Second),
	}
	return Resolve(config)
}

func Resolve(config Config) ingestion.EmbeddingAdapter {
	resolvedProvider := strings.ToLower(strings.TrimSpace(config.Provider))
	if resolvedProvider == "" {
		resolvedProvider = ProviderDeterministic
	}

	if strings.TrimSpace(config.Model) == "" && resolvedProvider == ProviderOpenAICompatible {
		config.Model = openai.DefaultModel
	}

	deterministicAdapter := deterministic.NewAdapter()
	if resolvedProvider == ProviderDeterministic {
		return deterministicAdapter
	}

	var primary ingestion.EmbeddingAdapter
	var setupErr error
	switch resolvedProvider {
	case ProviderOpenAICompatible:
		primary, setupErr = openai.NewAdapter(openai.Config{
			BaseURL: config.BaseURL,
			APIKey:  config.APIKey,
			Model:   config.Model,
			Timeout: config.Timeout,
		})
	default:
		setupErr = provider.AdapterError{
			Provider:  resolvedProvider,
			Model:     config.Model,
			Reason:    "provider-unsupported",
			Retryable: false,
			Err:       fmt.Errorf("unsupported EMBEDDING_PROVIDER=%q", resolvedProvider),
		}
	}

	return &managedAdapter{
		config:          config,
		provider:        resolvedProvider,
		primary:         primary,
		fallback:        deterministicAdapter,
		primarySetupErr: setupErr,
	}
}

type managedAdapter struct {
	config          Config
	provider        string
	primary         ingestion.EmbeddingAdapter
	fallback        ingestion.EmbeddingAdapter
	primarySetupErr error
}

func (a *managedAdapter) Embed(ctx context.Context, request ingestion.EmbeddingRequest) (ingestion.EmbeddingResult, error) {
	workingRequest := request
	if strings.TrimSpace(a.config.Model) != "" {
		workingRequest.Model = strings.TrimSpace(a.config.Model)
	}

	if a.primarySetupErr != nil {
		return a.handlePrimaryFailure(ctx, workingRequest, a.primarySetupErr)
	}
	if a.primary == nil {
		return a.handlePrimaryFailure(ctx, workingRequest, provider.AdapterError{
			Provider:  a.provider,
			Model:     workingRequest.Model,
			Reason:    "provider-not-configured",
			Retryable: false,
		})
	}

	result, err := a.primary.Embed(ctx, workingRequest)
	if err == nil {
		result.Metadata = mergeMap(result.Metadata, map[string]any{
			"embeddingProvider": a.provider,
			"embeddingModel":    result.Model,
			"vectorDimensions":  result.Dimensions,
		})
		return result, nil
	}

	return a.handlePrimaryFailure(ctx, workingRequest, err)
}

func (a *managedAdapter) handlePrimaryFailure(ctx context.Context, request ingestion.EmbeddingRequest, primaryErr error) (ingestion.EmbeddingResult, error) {
	fallbackReason := extractReason(primaryErr)
	primaryRetryable := extractRetryable(primaryErr, true)
	if !a.config.FallbackEnabled {
		return ingestion.EmbeddingResult{}, provider.AdapterError{
			Provider:  a.provider,
			Model:     request.Model,
			Reason:    fallbackReason,
			Retryable: primaryRetryable,
			Err:       primaryErr,
		}
	}

	result, fallbackErr := a.fallback.Embed(ctx, request)
	if fallbackErr != nil {
		return ingestion.EmbeddingResult{}, provider.AdapterError{
			Provider:  a.provider,
			Model:     request.Model,
			Reason:    "fallback-failed",
			Retryable: primaryRetryable,
			Err:       fmt.Errorf("primary=%v fallback=%w", primaryErr, fallbackErr),
		}
	}

	result.Metadata = mergeMap(result.Metadata, map[string]any{
		"embeddingProvider":        deterministic.ProviderName,
		"embeddingModel":           result.Model,
		"vectorDimensions":         result.Dimensions,
		"fallbackReason":           fallbackReason,
		"fallbackEnabled":          true,
		"fallbackFromProvider":     a.provider,
		"fallbackFromModel":        request.Model,
		"fallbackPrimaryError":     primaryErr.Error(),
		"fallbackPrimaryRetriable": primaryRetryable,
	})
	return result, nil
}

func parseBool(value string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true":
		return true
	case "false":
		return false
	default:
		return fallback
	}
}

func readTimeout(key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	parsedMs, err := strconv.Atoi(raw)
	if err != nil || parsedMs <= 0 {
		return fallback
	}
	return time.Duration(parsedMs) * time.Millisecond
}

func mergeMap(base map[string]any, extra map[string]any) map[string]any {
	next := map[string]any{}
	for key, value := range base {
		next[key] = value
	}
	for key, value := range extra {
		next[key] = value
	}
	return next
}

func extractReason(err error) string {
	type reasonError interface{ ErrorReason() string }
	var target reasonError
	if errors.As(err, &target) {
		reason := strings.TrimSpace(target.ErrorReason())
		if reason != "" {
			return reason
		}
	}
	return "provider-request-failed"
}

func extractRetryable(err error, fallback bool) bool {
	type retryableError interface{ IsRetryable() bool }
	var target retryableError
	if errors.As(err, &target) {
		return target.IsRetryable()
	}
	return fallback
}
