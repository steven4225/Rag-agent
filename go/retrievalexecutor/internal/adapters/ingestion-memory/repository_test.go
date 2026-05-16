package ingestionmemory

import (
	"context"
	"testing"
	"time"

	adapter "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestionstore"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

func TestClaimTerminalizesExhaustedRunningTask(t *testing.T) {
	repo := NewRepository()
	now := time.Now().UTC()
	task := ingestion.TaskStatus{
		TaskID:       "task-exhausted",
		TraceID:      "trace-exhausted",
		Status:       ingestion.StatusRunning,
		CurrentStage: ingestion.StageParser,
		AttemptCount: 2,
		MaxAttempts:  2,
		CreatedAt:    now.Add(-2 * time.Minute).Format(time.RFC3339),
		UpdatedAt:    now.Add(-1 * time.Minute).Format(time.RFC3339),
		StartedAt:    now.Add(-1 * time.Minute).Format(time.RFC3339),
		Metadata: map[string]any{
			"leaseExpiresAt": now.Add(-20 * time.Second).Format(time.RFC3339),
		},
	}
	if err := repo.Upsert(context.Background(), task); err != nil {
		t.Fatalf("expected setup upsert success, got %v", err)
	}

	_, err := repo.Claim(context.Background(), task.TaskID, "worker-b", now, 5*time.Second, false)
	if err != adapter.ErrTaskNotClaimable {
		t.Fatalf("expected ErrTaskNotClaimable, got %v", err)
	}

	terminal, err := repo.Get(context.Background(), task.TaskID)
	if err != nil {
		t.Fatalf("expected get success after claim rejection, got %v", err)
	}
	if terminal.Status != ingestion.StatusFailed || terminal.CurrentStage != ingestion.StageFailed {
		t.Fatalf("expected terminal failed state, got %s/%s", terminal.Status, terminal.CurrentStage)
	}
	if terminal.Metadata["terminalState"] != "dead-letter" || terminal.Metadata["deadLetter"] != true {
		t.Fatalf("expected dead-letter metadata, got %+v", terminal.Metadata)
	}
}
