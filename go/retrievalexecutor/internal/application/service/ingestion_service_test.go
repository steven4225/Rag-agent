package service

import (
	"context"
	"encoding/base64"
	"path/filepath"
	"testing"

	textchunker "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/chunker/textchunker"
	deterministicembedding "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/embedding/deterministic"
	jsonindexstore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexstore/jsonstore"
	ingestionmemory "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestion-memory"
	jsoningestionstore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestionstore/jsonstore"
	textparser "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/textparser"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
	"github.com/nageoffer/ragent/go/retrievalexecutor/pkg/contracts"
)

func TestIngestionServiceCreateTaskQueuesAndReusesActiveTask(t *testing.T) {
	repo := ingestionmemory.NewRepository()
	service := NewIngestionService(
		textparser.NewAdapter(),
		textchunker.NewChunker(),
		deterministicembedding.NewAdapter(),
		jsonindexstore.NewStore(filepath.Join(t.TempDir(), "index.json")),
		repo,
	)
	content := "# Policy Handbook\n\nParagraph one for ingestion."
	payload := contracts.IngestionTaskCreateRequest{
		TraceID:         "trace-789",
		KnowledgeBaseID: "kb_policy",
		DocumentID:      "doc_policy_1",
		RequestedBy:     "admin_demo",
		Source: contracts.IngestionSource{
			SourceType: "upload",
			URI:        "data:text/markdown;base64," + base64.StdEncoding.EncodeToString([]byte(content)),
			Filename:   "policy.md",
			MimeType:   "text/markdown",
			SizeBytes:  int64(len(content)),
		},
		ExecutionPlan: contracts.IngestionExecutionPlan{
			Parser:    contracts.ParserExecutionPlan{ParserType: "text-parser", Mode: "adapter"},
			Chunking:  contracts.ChunkingExecutionPlan{Strategy: "paragraph", TargetSize: 1200, Overlap: 120},
			Embedding: contracts.EmbeddingExecutionPlan{Enabled: true, Model: "mock-embedding-v1", Adapter: "deterministic"},
			Indexing:  contracts.IndexingExecutionPlan{Enabled: true, IndexName: "kb_policy", StoreType: "json-file"},
		},
	}

	created, err := service.CreateTask(context.Background(), payload)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if created.Status != ingestion.StatusPending {
		t.Fatalf("expected pending status, got %q", created.Status)
	}
	if created.CurrentStage != ingestion.StageQueued {
		t.Fatalf("expected queued stage, got %q", created.CurrentStage)
	}
	if created.AttemptCount != 0 {
		t.Fatalf("expected attemptCount=0, got %d", created.AttemptCount)
	}
	if created.MaxAttempts != 3 {
		t.Fatalf("expected maxAttempts=3, got %d", created.MaxAttempts)
	}

	replayed, err := service.CreateTask(context.Background(), contracts.IngestionTaskCreateRequest{
		TraceID:         "trace-790",
		KnowledgeBaseID: payload.KnowledgeBaseID,
		DocumentID:      payload.DocumentID,
		RequestedBy:     payload.RequestedBy,
		Source:          payload.Source,
		ExecutionPlan:   payload.ExecutionPlan,
	})
	if err != nil {
		t.Fatalf("expected replayed request to succeed, got %v", err)
	}
	if replayed.TaskID != created.TaskID {
		t.Fatalf("expected idempotency to reuse task id %q, got %q", created.TaskID, replayed.TaskID)
	}
	if replayed.Metadata["idempotencyOutcome"] != "reused-active-task" {
		t.Fatalf("expected reused-active-task metadata, got %#v", replayed.Metadata["idempotencyOutcome"])
	}
}

func TestIngestionServiceCreateTaskReusesFailedTaskUntilExplicitRetry(t *testing.T) {
	repo := ingestionmemory.NewRepository()
	service := NewIngestionService(
		textparser.NewAdapter(),
		textchunker.NewChunker(),
		deterministicembedding.NewAdapter(),
		jsonindexstore.NewStore(filepath.Join(t.TempDir(), "index.json")),
		repo,
	)

	created, err := service.CreateTask(context.Background(), contracts.IngestionTaskCreateRequest{
		TraceID:         "trace-801",
		KnowledgeBaseID: "kb_policy",
		DocumentID:      "doc_policy_2",
		RequestedBy:     "admin_demo",
		Source: contracts.IngestionSource{
			SourceType: "upload",
			URI:        "data:text/plain;base64," + base64.StdEncoding.EncodeToString([]byte("hello")),
			Filename:   "policy-2.txt",
			MimeType:   "text/plain",
			SizeBytes:  5,
		},
		ExecutionPlan: contracts.IngestionExecutionPlan{
			Parser:    contracts.ParserExecutionPlan{ParserType: "text-parser", Mode: "adapter"},
			Chunking:  contracts.ChunkingExecutionPlan{Strategy: "paragraph", TargetSize: 1200, Overlap: 120},
			Embedding: contracts.EmbeddingExecutionPlan{Enabled: true, Model: "mock-embedding-v1", Adapter: "deterministic"},
			Indexing:  contracts.IndexingExecutionPlan{Enabled: true, IndexName: "kb_policy", StoreType: "json-file"},
		},
	})
	if err != nil {
		t.Fatalf("expected create success, got %v", err)
	}

	failedDomainTask, err := repo.Get(context.Background(), created.TaskID)
	if err != nil {
		t.Fatalf("expected repo get success, got %v", err)
	}
	failedDomainTask.Status = ingestion.StatusFailed
	failedDomainTask.CurrentStage = ingestion.StageFailed
	failedDomainTask.ErrorMessage = "terminal failure"
	failedDomainTask.FailureReason = "terminal failure"
	failedDomainTask.FailureStage = ingestion.StageParser
	if err := repo.Upsert(context.Background(), failedDomainTask); err != nil {
		t.Fatalf("expected upsert failed state success, got %v", err)
	}

	replayed, err := service.CreateTask(context.Background(), contracts.IngestionTaskCreateRequest{
		TraceID:         "trace-802",
		KnowledgeBaseID: "kb_policy",
		DocumentID:      "doc_policy_2",
		RequestedBy:     "admin_demo",
		Source: contracts.IngestionSource{
			SourceType: "upload",
			URI:        "data:text/plain;base64," + base64.StdEncoding.EncodeToString([]byte("hello")),
			Filename:   "policy-2.txt",
			MimeType:   "text/plain",
			SizeBytes:  5,
		},
		ExecutionPlan: contracts.IngestionExecutionPlan{
			Parser:    contracts.ParserExecutionPlan{ParserType: "text-parser", Mode: "adapter"},
			Chunking:  contracts.ChunkingExecutionPlan{Strategy: "paragraph", TargetSize: 1200, Overlap: 120},
			Embedding: contracts.EmbeddingExecutionPlan{Enabled: true, Model: "mock-embedding-v1", Adapter: "deterministic"},
			Indexing:  contracts.IndexingExecutionPlan{Enabled: true, IndexName: "kb_policy", StoreType: "json-file"},
		},
	})
	if err != nil {
		t.Fatalf("expected replay for failed task success, got %v", err)
	}
	if replayed.TaskID != created.TaskID {
		t.Fatalf("expected replay to reuse failed task id %q, got %q", created.TaskID, replayed.TaskID)
	}
	if replayed.Metadata["idempotencyOutcome"] != "reused-failed-task-retry-required" {
		t.Fatalf("expected reused-failed-task-retry-required metadata, got %#v", replayed.Metadata["idempotencyOutcome"])
	}
}

func TestIngestionServiceTaskCanBeReadAfterServiceRestart(t *testing.T) {
	tempDir := t.TempDir()
	indexPath := filepath.Join(tempDir, "index.json")
	taskStorePath := filepath.Join(tempDir, "task-store.json")

	service := NewIngestionService(
		textparser.NewAdapter(),
		textchunker.NewChunker(),
		deterministicembedding.NewAdapter(),
		jsonindexstore.NewStore(indexPath),
		jsoningestionstore.NewStore(taskStorePath),
	)

	created, err := service.CreateTask(context.Background(), contracts.IngestionTaskCreateRequest{
		TraceID:         "trace-restart-1",
		KnowledgeBaseID: "kb_policy",
		DocumentID:      "doc_restart_1",
		RequestedBy:     "admin_demo",
		Source: contracts.IngestionSource{
			SourceType: "upload",
			URI:        "data:text/plain;base64," + base64.StdEncoding.EncodeToString([]byte("persist me")),
			Filename:   "restart.md",
			MimeType:   "text/markdown",
			SizeBytes:  10,
		},
		ExecutionPlan: contracts.IngestionExecutionPlan{
			Parser:    contracts.ParserExecutionPlan{ParserType: "text-parser", Mode: "adapter"},
			Chunking:  contracts.ChunkingExecutionPlan{Strategy: "paragraph", TargetSize: 1200, Overlap: 120},
			Embedding: contracts.EmbeddingExecutionPlan{Enabled: true, Model: "mock-embedding-v1", Adapter: "deterministic"},
			Indexing:  contracts.IndexingExecutionPlan{Enabled: true, IndexName: "kb_policy", StoreType: "json-file"},
		},
	})
	if err != nil {
		t.Fatalf("expected create task success, got %v", err)
	}

	restartedService := NewIngestionService(
		textparser.NewAdapter(),
		textchunker.NewChunker(),
		deterministicembedding.NewAdapter(),
		jsonindexstore.NewStore(indexPath),
		jsoningestionstore.NewStore(taskStorePath),
	)

	reloaded, err := restartedService.GetTask(context.Background(), created.TaskID)
	if err != nil {
		t.Fatalf("expected task lookup after restart success, got %v", err)
	}
	if reloaded.TaskID != created.TaskID {
		t.Fatalf("expected same task id after restart, got %q", reloaded.TaskID)
	}
	if reloaded.Status != ingestion.StatusPending {
		t.Fatalf("expected pending status after restart, got %q", reloaded.Status)
	}
	if reloaded.CurrentStage != ingestion.StageQueued {
		t.Fatalf("expected queued stage after restart, got %q", reloaded.CurrentStage)
	}
	if len(reloaded.Trace) < 2 {
		t.Fatalf("expected persisted create trace after restart")
	}
}
