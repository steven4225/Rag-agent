package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"time"

	textchunker "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/chunker/textchunker"
	embeddingresolver "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/embedding/resolver"
	indexstoreresolver "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexstore/resolver"
	ingestionstoreresolver "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestionstore/resolver"
	localcorpus "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/local-corpus"
	parserresolver "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/resolver"
	indexedsource "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/retrieval/indexedsource"
	sourceexecutor "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/retrieval/sourceexecutor"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/retrieval/reranker"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/application/scheduler"
	application "github.com/nageoffer/ragent/go/retrievalexecutor/internal/application/service"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/application/worker"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/retrieval"
	httptransport "github.com/nageoffer/ragent/go/retrievalexecutor/internal/transport/http"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8090"
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	taskRepository, err := ingestionstoreresolver.ResolveFromEnv()
	if err != nil {
		logger.Error("resolve ingestion task store failed", "error", err)
		os.Exit(1)
	}
	parserAdapter := parserresolver.ResolveFromEnv()
	chunker := textchunker.NewChunker()
	embeddingAdapter := embeddingresolver.ResolveFromEnv()
	indexStore, err := indexstoreresolver.ResolveFromEnv()
	if err != nil {
		logger.Error("resolve index store failed", "error", err)
		os.Exit(1)
	}

	localSource := localcorpus.NewSource(localcorpus.DefaultCorpus())

	var rerankAdapter retrieval.RerankAdapter
	if bgeURL := strings.TrimSpace(os.Getenv("BGE_RERANKER_URL")); bgeURL != "" {
		rerankAdapter = reranker.NewBGEReranker(bgeURL)
	}

	indexedStoreSource := indexedsource.NewSourceWithConfig(indexedsource.Config{
		Store:            indexStore,
		EmbeddingAdapter: embeddingAdapter,
		RetrievalMode:    resolveRetrievalMode(),
		RerankAdapter:    rerankAdapter,
	})
	executor := buildRetrievalExecutor(localSource, indexedStoreSource)
	retrievalService := application.NewRetrievalService(executor)
	ingestionService := application.NewIngestionService(parserAdapter, chunker, embeddingAdapter, indexStore, taskRepository)
	ingestionWorker := worker.NewIngestionWorker(parserAdapter, chunker, embeddingAdapter, indexStore, taskRepository)
	ingestionRunner := scheduler.NewIngestionRunner(
		taskRepository,
		ingestionWorker,
		resolveWorkerID(),
		readDurationEnv("GO_INGESTION_RUNNER_LEASE", 30*time.Second),
		readDurationEnv("GO_INGESTION_RUNNER_INTERVAL", 2*time.Second),
		readIntEnv("GO_INGESTION_RUNNER_LIMIT", 4),
	)

	health := httptransport.NewHealthRegistry()
	health.Register("taskStore", func(ctx context.Context) error {
		_, err := taskRepository.ListRecent(ctx, 0)
		return err
	})

	handler := httptransport.NewHandler(retrievalService, ingestionService, ingestionRunner, health)

	// Middleware chain: logging → ratelimit → auth → handler
	mux := handler.Routes()
	mux = httptransport.AuthMiddleware(mux)
	mux = httptransport.RateLimitMiddleware(mux)
	mux = httptransport.LoggingMiddleware(mux)

	// Graceful shutdown context
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()

	bgCtx, bgCancel := context.WithCancel(context.Background())
	defer bgCancel()

	if parseBool(os.Getenv("GO_INGESTION_RUNNER_ENABLED"), true) {
		go ingestionRunner.StartBackgroundLoop(bgCtx)
	}

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		<-ctx.Done()
		logger.Info("server shutting down...")
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		bgCancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			logger.Error("server shutdown error", "error", err)
		}
	}()

	logger.Info("go retrieval + ingestion executor listening", "port", port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
	logger.Info("server stopped")
}

func buildRetrievalExecutor(localSource retrieval.Source, indexedStoreSource retrieval.Source) retrieval.Executor {
	requestedSource := strings.TrimSpace(os.Getenv("GO_RETRIEVAL_SOURCE"))
	if requestedSource == "" {
		requestedSource = retrieval.SourceIndexedStore
	}

	fallbackEnabled := parseBool(os.Getenv("GO_RETRIEVAL_FALLBACK_ENABLED"), true)
	switch requestedSource {
	case retrieval.SourceLocalCorpus:
		return sourceexecutor.New(sourceexecutor.Config{
			Primary: localSource,
		})
	case retrieval.SourceIndexedStore:
		return sourceexecutor.New(sourceexecutor.Config{
			Primary:         indexedStoreSource,
			Fallback:        localSource,
			FallbackOnEmpty: fallbackEnabled,
			FallbackOnError: fallbackEnabled,
		})
	default:
		slog.Warn("unknown retrieval source, falling back", "raw", requestedSource, "default", retrieval.SourceLocalCorpus)
		return sourceexecutor.New(sourceexecutor.Config{
			Primary: localSource,
		})
	}
}

func parseBool(value string, defaultValue bool) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true":
		return true
	case "false":
		return false
	default:
		return defaultValue
	}
}

func readIntEnv(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func readDurationEnv(key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	if parsed, err := time.ParseDuration(raw); err == nil && parsed > 0 {
		return parsed
	}
	if seconds, err := strconv.Atoi(raw); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	return fallback
}

func resolveWorkerID() string {
	if workerID := strings.TrimSpace(os.Getenv("GO_INGESTION_WORKER_ID")); workerID != "" {
		return workerID
	}
	host, err := os.Hostname()
	if err != nil || strings.TrimSpace(host) == "" {
		return "go-ingestion-worker"
	}
	return "go-ingestion-worker-" + host
}

func resolveRetrievalMode() string {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv("GO_RETRIEVAL_MODE")))
	switch raw {
	case retrieval.RetrievalModeKeyword:
		return retrieval.RetrievalModeKeyword
	case retrieval.RetrievalModeVector:
		return retrieval.RetrievalModeVector
	case retrieval.RetrievalModeHybrid:
		return retrieval.RetrievalModeHybrid
	default:
		if raw != "" {
			slog.Warn("unknown retrieval mode, defaulting", "raw", raw, "default", retrieval.RetrievalModeHybrid)
		}
		return retrieval.RetrievalModeHybrid
	}
}
