package service

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	textchunker "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/chunker/textchunker"
	deterministicembedding "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/embedding/deterministic"
	embeddingresolver "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/embedding/resolver"
	jsonindexstore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexstore/jsonstore"
	ingestionmemory "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestion-memory"
	localcorpus "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/local-corpus"
	textparser "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/textparser"
	indexedsource "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/retrieval/indexedsource"
	sourceexecutor "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/retrieval/sourceexecutor"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/application/scheduler"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/application/worker"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/retrieval"
	"github.com/nageoffer/ragent/go/retrievalexecutor/pkg/contracts"
)

func TestRetrievalServiceSearchReturnsTSCompatibleShape(t *testing.T) {
	service := NewRetrievalService(localcorpus.NewExecutor(localcorpus.DefaultCorpus()))

	response, err := service.Search(context.Background(), contracts.RetrievalSearchRequest{
		TraceID:          "trace-123",
		Query:            "incident p1 runbook",
		KnowledgeBaseIDs: []string{"kb_ops"},
		TopK:             2,
		Filters: map[string]any{
			"category": "runbook",
		},
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if response.TraceID != "trace-123" {
		t.Fatalf("expected traceId to round-trip, got %q", response.TraceID)
	}
	if response.Source != retrieval.SourceLocalCorpus {
		t.Fatalf("expected source %q, got %q", retrieval.SourceLocalCorpus, response.Source)
	}
	if response.Timing.TotalMs != response.LatencyMs {
		t.Fatalf("expected timing.totalMs to mirror latencyMs")
	}
	if len(response.Chunks) != 1 {
		t.Fatalf("expected one chunk after kb and metadata filtering, got %d", len(response.Chunks))
	}
	if response.Chunks[0].KnowledgeBaseID != "kb_ops" {
		t.Fatalf("expected kb_ops chunk, got %q", response.Chunks[0].KnowledgeBaseID)
	}
}

func TestIngestionWorkerEmbeddingsFallbackMetadataPersistsToIndexRecords(t *testing.T) {
	indexPath := filepath.Join(t.TempDir(), "index.json")
	indexStore := jsonindexstore.NewStore(indexPath)
	taskRepo := ingestionmemory.NewRepository()
	parser := textparser.NewAdapter()
	chunker := textchunker.NewChunker()
	embedding := embeddingresolver.Resolve(embeddingresolver.Config{
		Provider:        "mock-provider-name",
		Model:           "text-embedding-3-small",
		FallbackEnabled: true,
	})

	ingestionService := NewIngestionService(parser, chunker, embedding, indexStore, taskRepo)
	ingestionWorker := worker.NewIngestionWorker(parser, chunker, embedding, indexStore, taskRepo)
	ingestionRunner := scheduler.NewIngestionRunner(taskRepo, ingestionWorker, "test-worker", 5*time.Second, 30*time.Second, 2)

	created, err := ingestionService.CreateTask(context.Background(), contracts.IngestionTaskCreateRequest{
		TraceID:         "trace-embedding-fallback",
		KnowledgeBaseID: "kb_fallback",
		DocumentID:      "doc_fallback",
		RequestedBy:     "admin_demo",
		Source: contracts.IngestionSource{
			SourceType: "upload",
			URI:        "data:text/plain,fallback%20embedding%20verification%20content",
			Filename:   "fallback.txt",
			MimeType:   "text/plain",
			SizeBytes:  40,
		},
		ExecutionPlan: contracts.IngestionExecutionPlan{
			Parser:    contracts.ParserExecutionPlan{ParserType: "text-parser", Mode: "adapter"},
			Chunking:  contracts.ChunkingExecutionPlan{Strategy: "paragraph", TargetSize: 1200, Overlap: 120},
			Embedding: contracts.EmbeddingExecutionPlan{Enabled: true, Adapter: "mock-provider-name"},
			Indexing:  contracts.IndexingExecutionPlan{Enabled: true, IndexName: "kb_fallback", StoreType: "json-file"},
		},
	})
	if err != nil {
		t.Fatalf("expected task create success, got %v", err)
	}

	finished, err := ingestionRunner.RunTask(context.Background(), created.TaskID)
	if err != nil {
		t.Fatalf("expected ingestion run success, got %v", err)
	}
	if finished.Status != "succeeded" {
		t.Fatalf("expected succeeded status, got %q", finished.Status)
	}
	if finished.EmbeddingResult == nil {
		t.Fatalf("expected embedding result")
	}
	if finished.IndexWriteResult == nil || len(finished.IndexWriteResult.Records) == 0 {
		t.Fatalf("expected index write records")
	}
	if got, _ := finished.EmbeddingResult.Metadata["fallbackReason"].(string); got != "provider-unsupported" {
		t.Fatalf("expected fallbackReason provider-unsupported, got %#v", finished.EmbeddingResult.Metadata["fallbackReason"])
	}
	recordMetadata := finished.IndexWriteResult.Records[0].Metadata
	required := []string{"embeddingProvider", "embeddingModel", "vectorDimensions", "embeddingSource", "embeddingDurationMs"}
	for _, key := range required {
		if _, ok := recordMetadata[key]; !ok {
			t.Fatalf("expected index record metadata key %q", key)
		}
	}
}

func TestRetrievalServiceReadsIndexedStoreRecordsWrittenByIngestion(t *testing.T) {
	indexPath := filepath.Join(t.TempDir(), "index.json")
	indexStore := jsonindexstore.NewStore(indexPath)
	taskRepo := ingestionmemory.NewRepository()
	parser := textparser.NewAdapter()
	chunker := textchunker.NewChunker()
	embedding := deterministicembedding.NewAdapter()

	ingestionService := NewIngestionService(
		parser,
		chunker,
		embedding,
		indexStore,
		taskRepo,
	)
	ingestionWorker := worker.NewIngestionWorker(parser, chunker, embedding, indexStore, taskRepo)
	ingestionRunner := scheduler.NewIngestionRunner(taskRepo, ingestionWorker, "test-worker", 5*time.Second, 30*time.Second, 2)

	created, err := ingestionService.CreateTask(context.Background(), contracts.IngestionTaskCreateRequest{
		TraceID:         "trace-indexed-ingest",
		KnowledgeBaseID: "kb_custom",
		DocumentID:      "doc_custom",
		RequestedBy:     "admin_demo",
		Source: contracts.IngestionSource{
			SourceType: "upload",
			URI:        "data:text/plain,release%20gate%20requires%20checklist%20and%20rollback%20guidance",
			Filename:   "release.txt",
			MimeType:   "text/plain",
			SizeBytes:  58,
		},
		ExecutionPlan: contracts.IngestionExecutionPlan{
			Parser: contracts.ParserExecutionPlan{
				ParserType: "text-parser",
				Mode:       "adapter",
			},
			Chunking: contracts.ChunkingExecutionPlan{
				Strategy:   "paragraph",
				TargetSize: 1200,
				Overlap:    120,
			},
			Embedding: contracts.EmbeddingExecutionPlan{
				Enabled: true,
				Model:   "mock-embedding-v1",
				Adapter: "deterministic",
			},
			Indexing: contracts.IndexingExecutionPlan{
				Enabled:   true,
				IndexName: "kb_custom",
				StoreType: "json-file",
			},
		},
	})
	if err != nil {
		t.Fatalf("expected ingestion to succeed, got %v", err)
	}
	if _, err := ingestionRunner.RunTask(context.Background(), created.TaskID); err != nil {
		t.Fatalf("expected worker to execute created task, got %v", err)
	}

	executor := sourceexecutor.New(sourceexecutor.Config{
		Primary:         indexedsource.NewSource(indexStore),
		Fallback:        localcorpus.NewSource(localcorpus.DefaultCorpus()),
		FallbackOnEmpty: false,
		FallbackOnError: false,
	})
	service := NewRetrievalService(executor)

	response, err := service.Search(context.Background(), contracts.RetrievalSearchRequest{
		TraceID:          "trace-indexed-search",
		Query:            "rollback checklist guidance",
		KnowledgeBaseIDs: []string{"kb_custom"},
		TopK:             3,
	})
	if err != nil {
		t.Fatalf("expected indexed-store retrieval to succeed, got %v", err)
	}

	if response.Source != retrieval.SourceIndexedStore {
		t.Fatalf("expected indexed-store source, got %q", response.Source)
	}
	if len(response.Chunks) == 0 {
		t.Fatalf("expected indexed-store chunks after ingestion")
	}
	if response.Chunks[0].KnowledgeBaseID != "kb_custom" {
		t.Fatalf("expected kb_custom chunk, got %q", response.Chunks[0].KnowledgeBaseID)
	}
}

func TestRetrievalServiceVectorModeUsesDeterministicEmbeddings(t *testing.T) {
	indexPath := filepath.Join(t.TempDir(), "index.json")
	indexStore := jsonindexstore.NewStore(indexPath)
	taskRepo := ingestionmemory.NewRepository()
	parser := textparser.NewAdapter()
	chunker := textchunker.NewChunker()
	embedding := deterministicembedding.NewAdapter()

	ingestionService := NewIngestionService(parser, chunker, embedding, indexStore, taskRepo)
	ingestionWorker := worker.NewIngestionWorker(parser, chunker, embedding, indexStore, taskRepo)
	ingestionRunner := scheduler.NewIngestionRunner(taskRepo, ingestionWorker, "test-worker", 5*time.Second, 30*time.Second, 2)

	created, err := ingestionService.CreateTask(context.Background(), contracts.IngestionTaskCreateRequest{
		TraceID:         "trace-indexed-vector",
		KnowledgeBaseID: "kb_vector",
		DocumentID:      "doc_vector",
		RequestedBy:     "admin_demo",
		Source: contracts.IngestionSource{
			SourceType: "upload",
			URI:        "data:text/plain,rollback%20runbook%20for%20production%20incident",
			Filename:   "runbook.txt",
			MimeType:   "text/plain",
			SizeBytes:  56,
		},
		ExecutionPlan: contracts.IngestionExecutionPlan{
			Parser:    contracts.ParserExecutionPlan{ParserType: "text-parser", Mode: "adapter"},
			Chunking:  contracts.ChunkingExecutionPlan{Strategy: "paragraph", TargetSize: 1200, Overlap: 120},
			Embedding: contracts.EmbeddingExecutionPlan{Enabled: true, Model: "mock-embedding-v1", Adapter: "deterministic"},
			Indexing:  contracts.IndexingExecutionPlan{Enabled: true, IndexName: "kb_vector", StoreType: "json-file"},
		},
	})
	if err != nil {
		t.Fatalf("expected ingestion create success, got %v", err)
	}
	if _, err := ingestionRunner.RunTask(context.Background(), created.TaskID); err != nil {
		t.Fatalf("expected ingestion run success, got %v", err)
	}

	executor := sourceexecutor.New(sourceexecutor.Config{
		Primary: indexedsource.NewSourceWithConfig(indexedsource.Config{
			Store:            indexStore,
			EmbeddingAdapter: embedding,
			RetrievalMode:    retrieval.RetrievalModeVector,
		}),
		FallbackOnEmpty: false,
		FallbackOnError: false,
	})
	service := NewRetrievalService(executor)

	response, err := service.Search(context.Background(), contracts.RetrievalSearchRequest{
		TraceID:          "trace-indexed-vector-search",
		Query:            "rollback runbook",
		KnowledgeBaseIDs: []string{"kb_vector"},
		TopK:             3,
	})
	if err != nil {
		t.Fatalf("expected vector retrieval success, got %v", err)
	}
	if len(response.Chunks) == 0 {
		t.Fatalf("expected vector retrieval chunks")
	}
	metadata := response.Chunks[0].Metadata
	if metadata["retrievalMode"] != retrieval.RetrievalModeVector {
		t.Fatalf("expected retrievalMode vector metadata, got %#v", metadata["retrievalMode"])
	}
	if metadata["scoreSource"] != retrieval.ScoreSourceVector {
		t.Fatalf("expected scoreSource vector metadata, got %#v", metadata["scoreSource"])
	}
	if metadata["queryEmbeddingProvider"] == "" || metadata["queryEmbeddingModel"] == "" {
		t.Fatalf("expected query embedding metadata, got %#v", metadata)
	}
}

type failingSource struct {
	name string
}

func (s failingSource) Name() string { return s.name }

func (s failingSource) Search(_ context.Context, _ retrieval.SearchInput) (retrieval.SourceResult, error) {
	return retrieval.SourceResult{}, errors.New("forced indexed-store read failure")
}

func TestRetrievalServiceAnnotatesFallbackWhenPrimaryErrors(t *testing.T) {
	executor := sourceexecutor.New(sourceexecutor.Config{
		Primary:         failingSource{name: retrieval.SourceIndexedStore},
		Fallback:        localcorpus.NewSource(localcorpus.DefaultCorpus()),
		FallbackOnEmpty: false,
		FallbackOnError: true,
	})
	service := NewRetrievalService(executor)

	response, err := service.Search(context.Background(), contracts.RetrievalSearchRequest{
		TraceID: "trace-fallback",
		Query:   "incident commander",
		TopK:    1,
	})
	if err != nil {
		t.Fatalf("expected retrieval fallback to succeed, got %v", err)
	}
	if response.Source != retrieval.SourceLocalCorpus {
		t.Fatalf("expected local fallback source, got %q", response.Source)
	}
	if len(response.Chunks) == 0 {
		t.Fatalf("expected at least one fallback chunk")
	}
	metadata := response.Chunks[0].Metadata
	if metadata["requestedSource"] != retrieval.SourceIndexedStore {
		t.Fatalf("expected requestedSource metadata, got %#v", metadata["requestedSource"])
	}
	if metadata["actualSource"] != retrieval.SourceLocalCorpus {
		t.Fatalf("expected actualSource metadata, got %#v", metadata["actualSource"])
	}
	if metadata["fallbackReason"] != "primary-source-error" {
		t.Fatalf("expected fallbackReason metadata, got %#v", metadata["fallbackReason"])
	}
	if metadata["errorSource"] != retrieval.SourceIndexedStore {
		t.Fatalf("expected errorSource metadata, got %#v", metadata["errorSource"])
	}
}
