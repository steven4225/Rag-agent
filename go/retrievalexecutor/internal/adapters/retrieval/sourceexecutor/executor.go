package sourceexecutor

import (
	"context"
	"errors"
	"time"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/retrieval/searchutil"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/retrieval"
)

var ErrPrimarySourceRequired = errors.New("primary retrieval source is required")

type Config struct {
	Primary         retrieval.Source
	Fallback        retrieval.Source
	FallbackOnEmpty bool
	FallbackOnError bool
}

type Executor struct {
	primary         retrieval.Source
	fallback        retrieval.Source
	fallbackOnEmpty bool
	fallbackOnError bool
}

func New(config Config) *Executor {
	return &Executor{
		primary:         config.Primary,
		fallback:        config.Fallback,
		fallbackOnEmpty: config.FallbackOnEmpty,
		fallbackOnError: config.FallbackOnError,
	}
}

func (e *Executor) Search(ctx context.Context, input retrieval.SearchInput) (retrieval.SearchResult, error) {
	startedAt := time.Now()

	if e.primary == nil {
		return retrieval.SearchResult{}, ErrPrimarySourceRequired
	}

	requestedSource := e.primary.Name()
	result, err := e.primary.Search(ctx, input)
	if err != nil {
		if e.fallback == nil || !e.fallbackOnError {
			return retrieval.SearchResult{}, err
		}

		fallbackReason := "primary-source-error"
		return e.searchFallback(ctx, input, requestedSource, fallbackReason, errorSourceFromErr(err, requestedSource), err.Error(), startedAt)
	}

	if result.Total == 0 && e.fallback != nil && e.fallbackOnEmpty {
		return e.searchFallback(ctx, input, requestedSource, "primary-empty", "", "", startedAt)
	}

	return retrieval.SearchResult{
		TraceID:   input.TraceID,
		Chunks:    annotateChunks(result.Chunks, requestedSource, requestedSource, "", "", ""),
		Total:     result.Total,
		LatencyMs: time.Since(startedAt).Milliseconds(),
		Source:    requestedSource,
	}, nil
}

func (e *Executor) searchFallback(
	ctx context.Context,
	input retrieval.SearchInput,
	requestedSource string,
	fallbackReason string,
	errorSource string,
	errorMessage string,
	startedAt time.Time,
) (retrieval.SearchResult, error) {
	// Use a context that won't be cancelled if the primary timed out.
	fallbackCtx := ctx
	if ctx.Err() != nil {
		fallbackCtx = context.WithoutCancel(ctx)
	}
	result, err := e.fallback.Search(fallbackCtx, input)
	if err != nil {
		return retrieval.SearchResult{}, err
	}

	actualSource := e.fallback.Name()
	return retrieval.SearchResult{
		TraceID:   input.TraceID,
		Chunks:    annotateChunks(result.Chunks, requestedSource, actualSource, fallbackReason, errorSource, errorMessage),
		Total:     result.Total,
		LatencyMs: time.Since(startedAt).Milliseconds(),
		Source:    actualSource,
	}, nil
}

func annotateChunks(
	chunks []retrieval.Chunk,
	requestedSource string,
	actualSource string,
	fallbackReason string,
	errorSource string,
	errorMessage string,
) []retrieval.Chunk {
	annotated := make([]retrieval.Chunk, 0, len(chunks))
	for _, chunk := range chunks {
		next := searchutil.CloneChunk(chunk)
		next.Source = actualSource
		next.Metadata["requestedSource"] = requestedSource
		next.Metadata["actualSource"] = actualSource
		if fallbackReason != "" {
			next.Metadata["fallbackReason"] = fallbackReason
		}
		if errorSource != "" {
			next.Metadata["errorSource"] = errorSource
		}
		if errorMessage != "" {
			next.Metadata["fallbackErrorMessage"] = errorMessage
		}
		annotated = append(annotated, next)
	}

	return annotated
}

type sourceNamedError interface {
	ErrorSource() string
}

func errorSourceFromErr(err error, defaultValue string) string {
	var typed sourceNamedError
	if errors.As(err, &typed) {
		if source := typed.ErrorSource(); source != "" {
			return source
		}
	}
	return defaultValue
}
