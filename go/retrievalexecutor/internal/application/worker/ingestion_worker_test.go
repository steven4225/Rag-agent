package worker

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexstore"
	ingestionmemory "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestion-memory"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/parsererrors"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

func TestWorkerSchedulesRetryForRetryableFailure(t *testing.T) {
	repo := ingestionmemory.NewRepository()
	task := baseTaskStatus()
	task.AttemptCount = 1
	task.MaxAttempts = 3
	if err := repo.Upsert(context.Background(), task); err != nil {
		t.Fatalf("expected setup upsert success, got %v", err)
	}

	worker := NewIngestionWorker(
		&stubParser{err: parsererrors.BackendUnavailable("tika", "tika unavailable", true, errors.New("dial timeout"))},
		&stubChunker{},
		&stubEmbedding{},
		&stubIndexStore{},
		repo,
	)

	finished, err := worker.Execute(context.Background(), task)
	if err != nil {
		t.Fatalf("expected worker execute success with retry scheduling, got %v", err)
	}
	if finished.Status != ingestion.StatusPending || finished.CurrentStage != ingestion.StageQueued {
		t.Fatalf("expected pending/queued after retry scheduling, got %s/%s", finished.Status, finished.CurrentStage)
	}
	if !finished.Retryable {
		t.Fatalf("expected retryable=true")
	}
	if finished.RetryAfterSec <= 0 || strings.TrimSpace(finished.NextRunAt) == "" {
		t.Fatalf("expected retryAfterSec and nextRunAt to be set, got retryAfterSec=%d nextRunAt=%q", finished.RetryAfterSec, finished.NextRunAt)
	}
	if got := finished.Metadata["retryPolicyTier"]; got != retryTierDependency {
		t.Fatalf("expected dependency retry tier, got %#v", got)
	}
	if got := finished.Metadata["terminalState"]; got != nil {
		t.Fatalf("expected terminalState to be cleared for retryable failure, got %#v", got)
	}
}

func TestWorkerMarksTerminalForNonRetryableFailure(t *testing.T) {
	repo := ingestionmemory.NewRepository()
	task := baseTaskStatus()
	task.AttemptCount = 1
	task.MaxAttempts = 3
	if err := repo.Upsert(context.Background(), task); err != nil {
		t.Fatalf("expected setup upsert success, got %v", err)
	}

	worker := NewIngestionWorker(
		&stubParser{err: parsererrors.DependencyMissing("tika", "tika not installed", errors.New("missing"))},
		&stubChunker{},
		&stubEmbedding{},
		&stubIndexStore{},
		repo,
	)

	finished, err := worker.Execute(context.Background(), task)
	if err != nil {
		t.Fatalf("expected worker execute success with terminal failure, got %v", err)
	}
	if finished.Status != ingestion.StatusFailed || finished.CurrentStage != ingestion.StageFailed {
		t.Fatalf("expected failed/failed for non-retryable error, got %s/%s", finished.Status, finished.CurrentStage)
	}
	if finished.Retryable || finished.RetryAfterSec != 0 || finished.NextRunAt != "" {
		t.Fatalf("expected retry fields to be cleared, got retryable=%v retryAfterSec=%d nextRunAt=%q", finished.Retryable, finished.RetryAfterSec, finished.NextRunAt)
	}
	if got := finished.Metadata["terminalState"]; got != "terminal-failure" {
		t.Fatalf("expected terminal-failure state, got %#v", got)
	}
	if got := finished.Metadata["deadLetter"]; got != false {
		t.Fatalf("expected deadLetter=false for non-retryable failure, got %#v", got)
	}
}

func TestWorkerMarksDeadLetterAfterAttemptsExhausted(t *testing.T) {
	repo := ingestionmemory.NewRepository()
	task := baseTaskStatus()
	task.AttemptCount = 1
	task.MaxAttempts = 1
	if err := repo.Upsert(context.Background(), task); err != nil {
		t.Fatalf("expected setup upsert success, got %v", err)
	}

	worker := NewIngestionWorker(
		&stubParser{err: parsererrors.BackendUnavailable("tika", "tika unavailable", true, errors.New("timeout"))},
		&stubChunker{},
		&stubEmbedding{},
		&stubIndexStore{},
		repo,
	)

	finished, err := worker.Execute(context.Background(), task)
	if err != nil {
		t.Fatalf("expected worker execute success with terminal dead-letter, got %v", err)
	}
	if finished.Status != ingestion.StatusFailed || finished.CurrentStage != ingestion.StageFailed {
		t.Fatalf("expected failed/failed after attempt budget exhaustion, got %s/%s", finished.Status, finished.CurrentStage)
	}
	if got := finished.Metadata["terminalState"]; got != "dead-letter" {
		t.Fatalf("expected dead-letter terminalState, got %#v", got)
	}
	if got := finished.Metadata["deadLetter"]; got != true {
		t.Fatalf("expected deadLetter=true after attempt budget exhaustion, got %#v", got)
	}
	if strings.TrimSpace(finished.Metadata["deadLetteredAt"].(string)) == "" {
		t.Fatalf("expected deadLetteredAt to be set")
	}
}

func baseTaskStatus() ingestion.TaskStatus {
	now := time.Now().UTC().Format(time.RFC3339)
	return ingestion.TaskStatus{
		TaskID:          "task-test",
		TraceID:         "trace-test",
		KnowledgeBaseID: "kb-test",
		DocumentID:      "doc-test",
		RequestedBy:     "tester",
		Source: ingestion.Source{
			SourceType: "upload",
			URI:        "data:text/plain,hello",
			Filename:   "hello.txt",
			MimeType:   "text/plain",
			SizeBytes:  5,
		},
		Status:       ingestion.StatusRunning,
		CurrentStage: ingestion.StageParser,
		CreatedAt:    now,
		UpdatedAt:    now,
		StartedAt:    now,
		ExecutionPlan: ingestion.ExecutionPlan{
			Parser: ingestion.ParserExecutionPlan{ParserType: "text-parser", Mode: "adapter"},
			Chunking: ingestion.ChunkingExecutionPlan{
				Strategy:   "paragraph",
				TargetSize: 1200,
				Overlap:    120,
			},
			Embedding: ingestion.EmbeddingExecutionPlan{
				Enabled: true,
				Model:   "mock-embedding-v1",
				Adapter: "deterministic",
			},
			Indexing: ingestion.IndexingExecutionPlan{
				Enabled:   true,
				IndexName: "kb-test",
				StoreType: "json-file",
			},
		},
		Metadata: map[string]any{},
	}
}

type stubParser struct {
	err error
}

func (s *stubParser) Parse(_ context.Context, _ ingestion.ParseRequest) (ingestion.ParseResult, error) {
	if s.err != nil {
		return ingestion.ParseResult{}, s.err
	}
	return ingestion.ParseResult{
		Status: "succeeded",
		ParsedDocument: &ingestion.ParsedDocument{
			DocumentID: "doc-test",
			Title:      "doc-test",
			MimeType:   "text/plain",
			CharCount:  1,
			Text:       "x",
		},
	}, nil
}

type stubChunker struct{}

func (s *stubChunker) Split(_ context.Context, _ ingestion.ParsedDocument, _ ingestion.ChunkingExecutionPlan) ([]ingestion.Chunk, int64, error) {
	return []ingestion.Chunk{}, 0, nil
}

type stubEmbedding struct{}

func (s *stubEmbedding) Embed(_ context.Context, _ ingestion.EmbeddingRequest) (ingestion.EmbeddingResult, error) {
	return ingestion.EmbeddingResult{}, nil
}

type stubIndexStore struct{}

func (s *stubIndexStore) Upsert(_ context.Context, _ indexstore.UpsertRequest) (indexstore.WriteResult, error) {
	return indexstore.WriteResult{}, nil
}
func (s *stubIndexStore) Query(_ context.Context, _ indexstore.QueryRequest) (indexstore.QueryResult, error) {
	return indexstore.QueryResult{}, nil
}
func (s *stubIndexStore) DeleteByDocument(_ context.Context, _ indexstore.DeleteByDocumentRequest) (indexstore.DeleteResult, error) {
	return indexstore.DeleteResult{}, nil
}
func (s *stubIndexStore) DeleteByKnowledgeBase(_ context.Context, _ indexstore.DeleteByKnowledgeBaseRequest) (indexstore.DeleteResult, error) {
	return indexstore.DeleteResult{}, nil
}
