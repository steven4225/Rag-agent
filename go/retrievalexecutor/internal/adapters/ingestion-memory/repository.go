package ingestionmemory

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"

	adapter "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestionstore"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

type Repository struct {
	mu    sync.RWMutex
	tasks map[string]ingestion.TaskStatus
}

func NewRepository() *Repository {
	return &Repository{
		tasks: make(map[string]ingestion.TaskStatus),
	}
}

func (r *Repository) Upsert(_ context.Context, task ingestion.TaskStatus) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tasks[task.TaskID] = cloneTask(task)
	return nil
}

func (r *Repository) Get(_ context.Context, taskID string) (ingestion.TaskStatus, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	task, ok := r.tasks[taskID]
	if !ok {
		return ingestion.TaskStatus{}, adapter.ErrTaskNotFound
	}

	return cloneTask(task), nil
}

func (r *Repository) FindByIdempotencyKey(_ context.Context, idempotencyKey string) (ingestion.TaskStatus, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, task := range r.sortedTasksLocked() {
		if key, _ := task.Metadata["idempotencyKey"].(string); key == idempotencyKey {
			return cloneTask(task), nil
		}
	}
	return ingestion.TaskStatus{}, adapter.ErrTaskNotFound
}

func (r *Repository) ListByKnowledgeBase(_ context.Context, knowledgeBaseID string, limit int) ([]ingestion.TaskStatus, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	filtered := make([]ingestion.TaskStatus, 0, len(r.tasks))
	for _, task := range r.sortedTasksLocked() {
		if task.KnowledgeBaseID != knowledgeBaseID {
			continue
		}
		filtered = append(filtered, cloneTask(task))
		if limit > 0 && len(filtered) >= limit {
			break
		}
	}
	return filtered, nil
}

func (r *Repository) ListRecent(_ context.Context, limit int) ([]ingestion.TaskStatus, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	tasks := r.sortedTasksLocked()
	if limit <= 0 || limit > len(tasks) {
		limit = len(tasks)
	}

	result := make([]ingestion.TaskStatus, 0, limit)
	for i := 0; i < limit; i++ {
		result = append(result, cloneTask(tasks[i]))
	}
	return result, nil
}

func (r *Repository) ListRunnable(_ context.Context, now time.Time, limit int) ([]ingestion.TaskStatus, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	result := make([]ingestion.TaskStatus, 0, len(r.tasks))
	for _, task := range r.sortedTasksLocked() {
		if isTaskRunnable(task, now) {
			result = append(result, cloneTask(task))
			if limit > 0 && len(result) >= limit {
				break
			}
		}
	}
	return result, nil
}

func (r *Repository) Claim(
	_ context.Context,
	taskID string,
	workerID string,
	now time.Time,
	leaseDuration time.Duration,
	force bool,
) (ingestion.TaskStatus, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	task, ok := r.tasks[taskID]
	if !ok {
		return ingestion.TaskStatus{}, adapter.ErrTaskNotFound
	}

	if !force && !isTaskRunnable(task, now) {
		return ingestion.TaskStatus{}, adapter.ErrTaskNotClaimable
	}
	if task.Status == ingestion.StatusSucceeded {
		return ingestion.TaskStatus{}, adapter.ErrTaskNotClaimable
	}
	if task.MaxAttempts <= 0 {
		task.MaxAttempts = 3
	}
	if task.AttemptCount >= task.MaxAttempts {
		if task.Status == ingestion.StatusPending || task.Status == ingestion.StatusRunning {
			task = markTerminalAttemptExhausted(task, now, "attempt-budget-exhausted-before-claim")
			r.tasks[taskID] = cloneTask(task)
		}
		return ingestion.TaskStatus{}, adapter.ErrTaskNotClaimable
	}

	task.AttemptCount += 1
	task.Status = ingestion.StatusRunning
	task.CurrentStage = ingestion.StageParser
	task.ErrorMessage = ""
	task.Retryable = false
	task.RetryAfterSec = 0
	task.NextRunAt = ""
	task.FailureReason = ""
	task.FailureStage = ""
	nowText := now.UTC().Format(time.RFC3339)
	task.UpdatedAt = nowText
	if strings.TrimSpace(task.StartedAt) == "" {
		task.StartedAt = nowText
	}
	task.FinishedAt = ""
	task.Metadata = mergeMaps(task.Metadata, map[string]any{
		"claimedBy":       workerID,
		"leaseExpiresAt":  now.Add(leaseDuration).UTC().Format(time.RFC3339),
		"lastClaimedAt":   nowText,
		"executionSource": "go-ingestion-worker",
	})

	r.tasks[taskID] = cloneTask(task)
	return cloneTask(task), nil
}

func (r *Repository) sortedTasksLocked() []ingestion.TaskStatus {
	tasks := make([]ingestion.TaskStatus, 0, len(r.tasks))
	for _, task := range r.tasks {
		tasks = append(tasks, cloneTask(task))
	}
	sort.Slice(tasks, func(i, j int) bool {
		if tasks[i].UpdatedAt == tasks[j].UpdatedAt {
			return tasks[i].CreatedAt > tasks[j].CreatedAt
		}
		return tasks[i].UpdatedAt > tasks[j].UpdatedAt
	})
	return tasks
}

func cloneTask(task ingestion.TaskStatus) ingestion.TaskStatus {
	bytes, err := json.Marshal(task)
	if err != nil {
		return task
	}
	var cloned ingestion.TaskStatus
	if err := json.Unmarshal(bytes, &cloned); err != nil {
		return task
	}
	return cloned
}

func isTaskRunnable(task ingestion.TaskStatus, now time.Time) bool {
	switch task.Status {
	case ingestion.StatusPending:
		return dueAtOrBefore(task.NextRunAt, now)
	case ingestion.StatusRunning:
		leaseExpiresAt := extractMetadataString(task.Metadata, "leaseExpiresAt")
		if strings.TrimSpace(leaseExpiresAt) == "" {
			return true
		}
		return dueAtOrBefore(leaseExpiresAt, now)
	default:
		return false
	}
}

func dueAtOrBefore(timestamp string, now time.Time) bool {
	value := strings.TrimSpace(timestamp)
	if value == "" {
		return true
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return true
	}
	return !parsed.After(now)
}

func extractMetadataString(metadata map[string]any, key string) string {
	if metadata == nil {
		return ""
	}
	value, _ := metadata[key].(string)
	return strings.TrimSpace(value)
}

func mergeMaps(base map[string]any, extra map[string]any) map[string]any {
	merged := map[string]any{}
	for key, value := range base {
		merged[key] = value
	}
	for key, value := range extra {
		merged[key] = value
	}
	return merged
}

func markTerminalAttemptExhausted(task ingestion.TaskStatus, now time.Time, reason string) ingestion.TaskStatus {
	nowText := now.UTC().Format(time.RFC3339)
	failureReason := strings.TrimSpace(task.FailureReason)
	if failureReason == "" {
		failureReason = reason
	}
	task.Status = ingestion.StatusFailed
	task.CurrentStage = ingestion.StageFailed
	task.Retryable = false
	task.NextRunAt = ""
	task.RetryAfterSec = 0
	task.FailureStage = ingestion.StageClaimed
	task.FailureReason = failureReason
	task.ErrorMessage = failureReason
	task.UpdatedAt = nowText
	task.FinishedAt = nowText
	task.Metadata = mergeMaps(task.Metadata, map[string]any{
		"retryable":              false,
		"attemptCount":           task.AttemptCount,
		"maxAttempts":            task.MaxAttempts,
		"attemptsRemaining":      0,
		"terminalState":          "dead-letter",
		"terminalReason":         reason,
		"terminalAt":             nowText,
		"deadLetter":             true,
		"deadLetteredAt":         nowText,
		"deadLetterFailureStage": ingestion.StageClaimed,
		"failureReason":          failureReason,
		"failureStage":           ingestion.StageClaimed,
	})
	task.Trace = append(task.Trace, ingestion.TraceEvent{
		TraceID:   task.TraceID,
		TaskID:    task.TaskID,
		Stage:     ingestion.StageFailed,
		Level:     "error",
		Status:    ingestion.StatusFailed,
		Message:   "task moved to terminal state before claim",
		Timestamp: nowText,
		Metadata: map[string]any{
			"reason":            reason,
			"terminalState":     "dead-letter",
			"attemptCount":      task.AttemptCount,
			"maxAttempts":       task.MaxAttempts,
			"attemptsRemaining": 0,
		},
	})
	return task
}
