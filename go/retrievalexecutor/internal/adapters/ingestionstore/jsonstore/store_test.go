package jsonstore

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	adapter "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestionstore"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

func TestStorePersistsAndFindsByIdempotencyKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ingestion-task-store.json")
	store := NewStore(path)
	ctx := context.Background()

	task := ingestion.TaskStatus{
		TaskID:          "task-1",
		TraceID:         "trace-1",
		KnowledgeBaseID: "kb_policy",
		DocumentID:      "doc-1",
		Status:          ingestion.StatusSucceeded,
		CurrentStage:    ingestion.StageCompleted,
		CreatedAt:       time.Now().UTC().Format(time.RFC3339),
		UpdatedAt:       time.Now().UTC().Format(time.RFC3339),
		Trace: []ingestion.TraceEvent{
			{
				TraceID:   "trace-1",
				TaskID:    "task-1",
				Stage:     "completed",
				Level:     "info",
				Status:    ingestion.StatusSucceeded,
				Message:   "done",
				Timestamp: time.Now().UTC().Format(time.RFC3339),
			},
		},
		Metadata: map[string]any{
			"idempotencyKey": "idem-1",
		},
	}

	if err := store.Upsert(ctx, task); err != nil {
		t.Fatalf("expected upsert success, got %v", err)
	}

	reloaded := NewStore(path)
	got, err := reloaded.Get(ctx, "task-1")
	if err != nil {
		t.Fatalf("expected task after restart, got %v", err)
	}
	if got.DocumentID != "doc-1" || len(got.Trace) != 1 {
		t.Fatalf("expected persisted task payload, got %+v", got)
	}

	byIdempotency, err := reloaded.FindByIdempotencyKey(ctx, "idem-1")
	if err != nil {
		t.Fatalf("expected idempotency lookup success, got %v", err)
	}
	if byIdempotency.TaskID != "task-1" {
		t.Fatalf("expected task-1 from idempotency lookup, got %q", byIdempotency.TaskID)
	}

	list, err := reloaded.ListByKnowledgeBase(ctx, "kb_policy", 10)
	if err != nil {
		t.Fatalf("expected kb listing success, got %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected one kb task, got %d", len(list))
	}

	recent, err := reloaded.ListRecent(ctx, 10)
	if err != nil {
		t.Fatalf("expected recent listing success, got %v", err)
	}
	if len(recent) != 1 {
		t.Fatalf("expected one recent task, got %d", len(recent))
	}
}

func TestStoreReturnsNotFound(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "ingestion-task-store.json"))
	_, err := store.Get(context.Background(), "missing")
	if err == nil {
		t.Fatalf("expected not found error")
	}
	if err != adapter.ErrTaskNotFound {
		t.Fatalf("expected ErrTaskNotFound, got %v", err)
	}
}

func TestStoreClaimTerminalizesExhaustedRunningTask(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ingestion-task-store.json")
	store := NewStore(path)
	ctx := context.Background()
	now := time.Now().UTC()
	task := ingestion.TaskStatus{
		TaskID:       "task-exhausted",
		TraceID:      "trace-exhausted",
		Status:       ingestion.StatusRunning,
		CurrentStage: ingestion.StageParser,
		AttemptCount: 3,
		MaxAttempts:  3,
		CreatedAt:    now.Add(-2 * time.Minute).Format(time.RFC3339),
		UpdatedAt:    now.Add(-1 * time.Minute).Format(time.RFC3339),
		StartedAt:    now.Add(-1 * time.Minute).Format(time.RFC3339),
		Metadata: map[string]any{
			"leaseExpiresAt": now.Add(-30 * time.Second).Format(time.RFC3339),
			"claimedBy":      "worker-a",
		},
	}
	if err := store.Upsert(ctx, task); err != nil {
		t.Fatalf("expected setup upsert success, got %v", err)
	}

	_, claimErr := store.Claim(ctx, task.TaskID, "worker-b", now, 5*time.Second, false)
	if claimErr != adapter.ErrTaskNotClaimable {
		t.Fatalf("expected ErrTaskNotClaimable, got %v", claimErr)
	}

	terminal, err := store.Get(ctx, task.TaskID)
	if err != nil {
		t.Fatalf("expected get after claim attempt success, got %v", err)
	}
	if terminal.Status != ingestion.StatusFailed || terminal.CurrentStage != ingestion.StageFailed {
		t.Fatalf("expected exhausted task to transition to failed/failed, got %s/%s", terminal.Status, terminal.CurrentStage)
	}
	if terminal.Metadata["terminalState"] != "dead-letter" || terminal.Metadata["deadLetter"] != true {
		t.Fatalf("expected dead-letter metadata after terminalization, got %+v", terminal.Metadata)
	}
}
