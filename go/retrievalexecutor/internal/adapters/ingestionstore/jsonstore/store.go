package jsonstore

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	adapter "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestionstore"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

const (
	DefaultTaskStorePath = "tmp/go-ingestion-task-store.json"
)

type Store struct {
	mu     sync.Mutex
	path   string
	loaded bool
	tasks  map[string]ingestion.TaskStatus
}

type filePayload struct {
	Version int                    `json:"version"`
	Tasks   []ingestion.TaskStatus `json:"tasks"`
}

func NewStore(path string) *Store {
	if strings.TrimSpace(path) == "" {
		path = DefaultTaskStorePath
	}
	return &Store{
		path:  path,
		tasks: map[string]ingestion.TaskStatus{},
	}
}

func (s *Store) Upsert(_ context.Context, task ingestion.TaskStatus) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.ensureLoadedLocked(); err != nil {
		return err
	}

	s.tasks[task.TaskID] = cloneTask(task)
	return s.persistLocked()
}

func (s *Store) Get(_ context.Context, taskID string) (ingestion.TaskStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.ensureLoadedLocked(); err != nil {
		return ingestion.TaskStatus{}, err
	}

	task, ok := s.tasks[taskID]
	if !ok {
		return ingestion.TaskStatus{}, adapter.ErrTaskNotFound
	}
	return cloneTask(task), nil
}

func (s *Store) FindByIdempotencyKey(_ context.Context, idempotencyKey string) (ingestion.TaskStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.ensureLoadedLocked(); err != nil {
		return ingestion.TaskStatus{}, err
	}

	targetKey := strings.TrimSpace(idempotencyKey)
	if targetKey == "" {
		return ingestion.TaskStatus{}, adapter.ErrTaskNotFound
	}

	tasks := s.sortedTasksLocked()
	for _, task := range tasks {
		if resolveTaskIdempotencyKey(task) == targetKey {
			return cloneTask(task), nil
		}
	}

	return ingestion.TaskStatus{}, adapter.ErrTaskNotFound
}

func (s *Store) ListByKnowledgeBase(_ context.Context, knowledgeBaseID string, limit int) ([]ingestion.TaskStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.ensureLoadedLocked(); err != nil {
		return nil, err
	}

	tasks := s.sortedTasksLocked()
	filtered := make([]ingestion.TaskStatus, 0, len(tasks))
	for _, task := range tasks {
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

func (s *Store) ListRecent(_ context.Context, limit int) ([]ingestion.TaskStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.ensureLoadedLocked(); err != nil {
		return nil, err
	}

	tasks := s.sortedTasksLocked()
	if limit <= 0 || limit > len(tasks) {
		limit = len(tasks)
	}

	result := make([]ingestion.TaskStatus, 0, limit)
	for i := 0; i < limit; i++ {
		result = append(result, cloneTask(tasks[i]))
	}
	return result, nil
}

func (s *Store) ListRunnable(_ context.Context, now time.Time, limit int) ([]ingestion.TaskStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.ensureLoadedLocked(); err != nil {
		return nil, err
	}

	candidates := make([]ingestion.TaskStatus, 0, len(s.tasks))
	for _, task := range s.sortedTasksLocked() {
		if isTaskRunnable(task, now) {
			candidates = append(candidates, cloneTask(task))
			if limit > 0 && len(candidates) >= limit {
				break
			}
		}
	}

	return candidates, nil
}

func (s *Store) Claim(
	_ context.Context,
	taskID string,
	workerID string,
	now time.Time,
	leaseDuration time.Duration,
	force bool,
) (ingestion.TaskStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.ensureLoadedLocked(); err != nil {
		return ingestion.TaskStatus{}, err
	}

	task, ok := s.tasks[taskID]
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
			s.tasks[taskID] = cloneTask(task)
			if err := s.persistLocked(); err != nil {
				return ingestion.TaskStatus{}, err
			}
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

	s.tasks[taskID] = cloneTask(task)
	if err := s.persistLocked(); err != nil {
		return ingestion.TaskStatus{}, err
	}
	return cloneTask(task), nil
}

func (s *Store) ensureLoadedLocked() error {
	if s.loaded {
		return nil
	}

	payload, err := s.loadPayloadLocked()
	if err != nil {
		return err
	}

	for _, task := range payload.Tasks {
		if strings.TrimSpace(task.TaskID) == "" {
			continue
		}
		s.tasks[task.TaskID] = cloneTask(task)
	}
	s.loaded = true
	return nil
}

func (s *Store) loadPayloadLocked() (filePayload, error) {
	if _, err := os.Stat(s.path); err != nil {
		if os.IsNotExist(err) {
			return filePayload{Version: 1, Tasks: []ingestion.TaskStatus{}}, nil
		}
		return filePayload{}, err
	}

	bytes, err := os.ReadFile(s.path)
	if err != nil {
		return filePayload{}, err
	}
	if len(bytes) == 0 {
		return filePayload{Version: 1, Tasks: []ingestion.TaskStatus{}}, nil
	}

	var payload filePayload
	if err := json.Unmarshal(bytes, &payload); err != nil {
		return filePayload{}, err
	}
	if payload.Tasks == nil {
		payload.Tasks = []ingestion.TaskStatus{}
	}
	if payload.Version == 0 {
		payload.Version = 1
	}
	return payload, nil
}

func (s *Store) persistLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}

	payload := filePayload{
		Version: 1,
		Tasks:   s.sortedTasksLocked(),
	}

	bytes, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}

	dir := filepath.Dir(s.path)
	tmpFile, err := os.CreateTemp(dir, "ingestion-task-store-*.tmp")
	if err != nil {
		return err
	}

	tmpPath := tmpFile.Name()
	defer func() {
		_ = os.Remove(tmpPath)
	}()

	if _, err := tmpFile.Write(bytes); err != nil {
		_ = tmpFile.Close()
		return err
	}
	if err := tmpFile.Close(); err != nil {
		return err
	}

	_ = os.Remove(s.path)
	return os.Rename(tmpPath, s.path)
}

func (s *Store) sortedTasksLocked() []ingestion.TaskStatus {
	tasks := make([]ingestion.TaskStatus, 0, len(s.tasks))
	for _, task := range s.tasks {
		tasks = append(tasks, cloneTask(task))
	}

	sort.Slice(tasks, func(i, j int) bool {
		leftTime := strings.TrimSpace(tasks[i].UpdatedAt)
		rightTime := strings.TrimSpace(tasks[j].UpdatedAt)
		if leftTime == rightTime {
			return tasks[i].CreatedAt > tasks[j].CreatedAt
		}
		return leftTime > rightTime
	})
	return tasks
}

func resolveTaskIdempotencyKey(task ingestion.TaskStatus) string {
	if task.Metadata == nil {
		return ""
	}
	value, _ := task.Metadata["idempotencyKey"].(string)
	return strings.TrimSpace(value)
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
