package mysqlstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
	adapter "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestionstore"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

const (
	StoreType  = "mysql"
	SourceName = "go-mysql-ingestion-task-store"
	driverName = "mysql"
)

type Config struct {
	DSN               string
	BootstrapJSONPath string
}

type Store struct {
	db  *sql.DB
	dsn string
}

type filePayload struct {
	Version int                    `json:"version"`
	Tasks   []ingestion.TaskStatus `json:"tasks"`
}

type taskProjection struct {
	TaskJSON          string
	TraceID           string
	KnowledgeBaseID   string
	DocumentID        string
	Status            string
	CurrentStage      string
	AttemptCount      int
	MaxAttempts       int
	Retryable         int
	NextRunAt         string
	UpdatedAt         string
	CreatedAt         string
	IdempotencyKey    string
	LeaseExpiresAt    string
	LastErrorAt       string
	TerminalState     string
	TerminalReason    string
	DeadLetteredAt    string
	DeadLetter        int
	ExecutionSource   string
	RetryClass        string
	RetryPolicyTier   string
	AttemptsRemaining int
}

func NewStore(config Config) (*Store, error) {
	dsn := strings.TrimSpace(config.DSN)
	if dsn == "" {
		return nil, fmt.Errorf("mysql dsn is required")
	}

	db, err := sql.Open(driverName, dsn)
	if err != nil {
		return nil, err
	}

	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(30 * time.Minute)

	store := &Store{
		db:  db,
		dsn: dsn,
	}
	if err := store.ensureSchema(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := store.bootstrapFromJSON(config.BootstrapJSONPath); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Upsert(ctx context.Context, task ingestion.TaskStatus) error {
	return s.upsert(ctx, task)
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) Get(ctx context.Context, taskID string) (ingestion.TaskStatus, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT task_json
FROM ingestion_tasks
WHERE task_id = ?`, taskID)

	var taskJSON string
	if err := row.Scan(&taskJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ingestion.TaskStatus{}, adapter.ErrTaskNotFound
		}
		return ingestion.TaskStatus{}, err
	}
	return decodeTask(taskJSON)
}

func (s *Store) FindByIdempotencyKey(ctx context.Context, idempotencyKey string) (ingestion.TaskStatus, error) {
	key := strings.TrimSpace(idempotencyKey)
	if key == "" {
		return ingestion.TaskStatus{}, adapter.ErrTaskNotFound
	}

	row := s.db.QueryRowContext(ctx, `
SELECT task_json
FROM ingestion_tasks
WHERE idempotency_key = ?
ORDER BY updated_at DESC
LIMIT 1`, key)

	var taskJSON string
	if err := row.Scan(&taskJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ingestion.TaskStatus{}, adapter.ErrTaskNotFound
		}
		return ingestion.TaskStatus{}, err
	}
	return decodeTask(taskJSON)
}

func (s *Store) ListByKnowledgeBase(ctx context.Context, knowledgeBaseID string, limit int) ([]ingestion.TaskStatus, error) {
	args := []any{knowledgeBaseID}
	query := `
SELECT task_json
FROM ingestion_tasks
WHERE knowledge_base_id = ?
ORDER BY updated_at DESC`
	if limit > 0 {
		query += "\nLIMIT ?"
		args = append(args, limit)
	}
	return s.listByQuery(ctx, query, args...)
}

func (s *Store) ListRecent(ctx context.Context, limit int) ([]ingestion.TaskStatus, error) {
	args := []any{}
	query := `
SELECT task_json
FROM ingestion_tasks
ORDER BY updated_at DESC`
	if limit > 0 {
		query += "\nLIMIT ?"
		args = append(args, limit)
	}
	return s.listByQuery(ctx, query, args...)
}

func (s *Store) ListRunnable(ctx context.Context, now time.Time, limit int) ([]ingestion.TaskStatus, error) {
	nowText := now.UTC().Format(time.RFC3339)
	args := []any{ingestion.StatusPending, nowText, ingestion.StatusRunning, nowText}
	query := `
SELECT task_json
FROM ingestion_tasks
WHERE
	(
		status = ?
		AND (next_run_at = '' OR next_run_at IS NULL OR next_run_at <= ?)
	)
	OR
	(
		status = ?
		AND (lease_expires_at = '' OR lease_expires_at IS NULL OR lease_expires_at <= ?)
	)
ORDER BY updated_at DESC`
	if limit > 0 {
		query += "\nLIMIT ?"
		args = append(args, limit)
	}
	return s.listByQuery(ctx, query, args...)
}

func (s *Store) Claim(
	ctx context.Context,
	taskID string,
	workerID string,
	now time.Time,
	leaseDuration time.Duration,
	force bool,
) (ingestion.TaskStatus, error) {
	task, err := s.Get(ctx, taskID)
	if err != nil {
		return ingestion.TaskStatus{}, err
	}

	originalUpdatedAt := task.UpdatedAt
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
			updated, updateErr := s.upsertIfUnchanged(ctx, originalUpdatedAt, task)
			if updateErr != nil {
				return ingestion.TaskStatus{}, updateErr
			}
			if !updated {
				return ingestion.TaskStatus{}, adapter.ErrTaskNotClaimable
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

	updated, updateErr := s.upsertIfUnchanged(ctx, originalUpdatedAt, task)
	if updateErr != nil {
		return ingestion.TaskStatus{}, updateErr
	}
	if !updated {
		return ingestion.TaskStatus{}, adapter.ErrTaskNotClaimable
	}
	return cloneTask(task), nil
}

func (s *Store) ensureSchema() error {
	schema := []string{
		`CREATE TABLE IF NOT EXISTS ingestion_tasks (
			task_id VARCHAR(191) NOT NULL PRIMARY KEY,
			trace_id VARCHAR(191) NOT NULL,
			knowledge_base_id VARCHAR(191) NOT NULL,
			document_id VARCHAR(191) NOT NULL,
			status VARCHAR(32) NOT NULL,
			current_stage VARCHAR(64) NOT NULL,
			attempt_count INT NOT NULL,
			max_attempts INT NOT NULL,
			retryable TINYINT(1) NOT NULL,
			next_run_at VARCHAR(64),
			updated_at VARCHAR(64) NOT NULL,
			created_at VARCHAR(64) NOT NULL,
			idempotency_key VARCHAR(191),
			lease_expires_at VARCHAR(64),
			last_error_at VARCHAR(64),
			terminal_state VARCHAR(64),
			terminal_reason VARCHAR(255),
			dead_lettered_at VARCHAR(64),
			dead_letter TINYINT(1) NOT NULL DEFAULT 0,
			execution_source VARCHAR(128),
			retry_class VARCHAR(64),
			retry_policy_tier VARCHAR(64),
			attempts_remaining INT,
			task_json LONGTEXT NOT NULL
		);`,
		`CREATE INDEX idx_ingestion_tasks_updated_at
			ON ingestion_tasks(updated_at);`,
		`CREATE INDEX idx_ingestion_tasks_kb_updated_at
			ON ingestion_tasks(knowledge_base_id, updated_at);`,
		`CREATE INDEX idx_ingestion_tasks_idempotency_key
			ON ingestion_tasks(idempotency_key);`,
		`CREATE INDEX idx_ingestion_tasks_runnable_pending
			ON ingestion_tasks(status, next_run_at, updated_at);`,
		`CREATE INDEX idx_ingestion_tasks_runnable_running
			ON ingestion_tasks(status, lease_expires_at, updated_at);`,
	}

	for _, query := range schema {
		if _, err := s.db.Exec(query); err != nil {
			if isDuplicateIndexError(err) {
				continue
			}
			return err
		}
	}
	return nil
}

func (s *Store) bootstrapFromJSON(path string) error {
	jsonPath := strings.TrimSpace(path)
	if jsonPath == "" {
		return nil
	}

	count, err := s.countTasks(context.Background())
	if err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	bytes, err := os.ReadFile(jsonPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if len(bytes) == 0 {
		return nil
	}

	var payload filePayload
	if err := json.Unmarshal(bytes, &payload); err != nil {
		return fmt.Errorf("bootstrap json parse failed: %w", err)
	}
	if len(payload.Tasks) == 0 {
		return nil
	}

	for _, task := range payload.Tasks {
		if strings.TrimSpace(task.TaskID) == "" {
			continue
		}
		if err := s.upsert(context.Background(), task); err != nil {
			return fmt.Errorf("bootstrap task %q failed: %w", task.TaskID, err)
		}
	}
	return nil
}

func (s *Store) upsert(ctx context.Context, task ingestion.TaskStatus) error {
	task = cloneTask(task)
	projection, err := projectTask(task)
	if err != nil {
		return err
	}

	_, err = s.db.ExecContext(ctx, `
INSERT INTO ingestion_tasks (
	task_id, trace_id, knowledge_base_id, document_id, status, current_stage,
	attempt_count, max_attempts, retryable, next_run_at, updated_at, created_at,
	idempotency_key, lease_expires_at, last_error_at, terminal_state, terminal_reason,
	dead_lettered_at, dead_letter, execution_source, retry_class, retry_policy_tier,
	attempts_remaining, task_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
	trace_id = VALUES(trace_id),
	knowledge_base_id = VALUES(knowledge_base_id),
	document_id = VALUES(document_id),
	status = VALUES(status),
	current_stage = VALUES(current_stage),
	attempt_count = VALUES(attempt_count),
	max_attempts = VALUES(max_attempts),
	retryable = VALUES(retryable),
	next_run_at = VALUES(next_run_at),
	updated_at = VALUES(updated_at),
	created_at = VALUES(created_at),
	idempotency_key = VALUES(idempotency_key),
	lease_expires_at = VALUES(lease_expires_at),
	last_error_at = VALUES(last_error_at),
	terminal_state = VALUES(terminal_state),
	terminal_reason = VALUES(terminal_reason),
	dead_lettered_at = VALUES(dead_lettered_at),
	dead_letter = VALUES(dead_letter),
	execution_source = VALUES(execution_source),
	retry_class = VALUES(retry_class),
	retry_policy_tier = VALUES(retry_policy_tier),
	attempts_remaining = VALUES(attempts_remaining),
	task_json = VALUES(task_json)
`, task.TaskID, projection.TraceID, projection.KnowledgeBaseID, projection.DocumentID, projection.Status,
		projection.CurrentStage, projection.AttemptCount, projection.MaxAttempts, projection.Retryable,
		projection.NextRunAt, projection.UpdatedAt, projection.CreatedAt, projection.IdempotencyKey,
		projection.LeaseExpiresAt, projection.LastErrorAt, projection.TerminalState, projection.TerminalReason,
		projection.DeadLetteredAt, projection.DeadLetter, projection.ExecutionSource, projection.RetryClass,
		projection.RetryPolicyTier, projection.AttemptsRemaining, projection.TaskJSON)
	return err
}

func (s *Store) upsertIfUnchanged(ctx context.Context, previousUpdatedAt string, task ingestion.TaskStatus) (bool, error) {
	task = cloneTask(task)
	projection, err := projectTask(task)
	if err != nil {
		return false, err
	}

	result, err := s.db.ExecContext(ctx, `
UPDATE ingestion_tasks
SET
	trace_id = ?,
	knowledge_base_id = ?,
	document_id = ?,
	status = ?,
	current_stage = ?,
	attempt_count = ?,
	max_attempts = ?,
	retryable = ?,
	next_run_at = ?,
	updated_at = ?,
	created_at = ?,
	idempotency_key = ?,
	lease_expires_at = ?,
	last_error_at = ?,
	terminal_state = ?,
	terminal_reason = ?,
	dead_lettered_at = ?,
	dead_letter = ?,
	execution_source = ?,
	retry_class = ?,
	retry_policy_tier = ?,
	attempts_remaining = ?,
	task_json = ?
WHERE task_id = ? AND updated_at = ?
`, projection.TraceID, projection.KnowledgeBaseID, projection.DocumentID, projection.Status, projection.CurrentStage,
		projection.AttemptCount, projection.MaxAttempts, projection.Retryable, projection.NextRunAt, projection.UpdatedAt,
		projection.CreatedAt, projection.IdempotencyKey, projection.LeaseExpiresAt, projection.LastErrorAt, projection.TerminalState,
		projection.TerminalReason, projection.DeadLetteredAt, projection.DeadLetter, projection.ExecutionSource,
		projection.RetryClass, projection.RetryPolicyTier, projection.AttemptsRemaining, projection.TaskJSON, task.TaskID, previousUpdatedAt)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return affected > 0, nil
}

func (s *Store) listByQuery(ctx context.Context, query string, args ...any) ([]ingestion.TaskStatus, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := []ingestion.TaskStatus{}
	for rows.Next() {
		var taskJSON string
		if err := rows.Scan(&taskJSON); err != nil {
			return nil, err
		}
		task, err := decodeTask(taskJSON)
		if err != nil {
			return nil, err
		}
		result = append(result, task)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Store) countTasks(ctx context.Context) (int, error) {
	row := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM ingestion_tasks`)
	var count int
	if err := row.Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func projectTask(task ingestion.TaskStatus) (taskProjection, error) {
	bytes, err := json.Marshal(task)
	if err != nil {
		return taskProjection{}, err
	}

	metadata := cloneMap(task.Metadata)
	maxAttempts := task.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = 3
	}
	attemptsRemaining := maxAttempts - task.AttemptCount
	if attemptsRemaining < 0 {
		attemptsRemaining = 0
	}

	return taskProjection{
		TaskJSON:          string(bytes),
		TraceID:           task.TraceID,
		KnowledgeBaseID:   task.KnowledgeBaseID,
		DocumentID:        task.DocumentID,
		Status:            task.Status,
		CurrentStage:      task.CurrentStage,
		AttemptCount:      task.AttemptCount,
		MaxAttempts:       maxAttempts,
		Retryable:         boolToInt(task.Retryable),
		NextRunAt:         task.NextRunAt,
		UpdatedAt:         task.UpdatedAt,
		CreatedAt:         task.CreatedAt,
		IdempotencyKey:    metadataString(metadata, "idempotencyKey"),
		LeaseExpiresAt:    metadataString(metadata, "leaseExpiresAt"),
		LastErrorAt:       metadataString(metadata, "lastErrorAt"),
		TerminalState:     metadataString(metadata, "terminalState"),
		TerminalReason:    metadataString(metadata, "terminalReason"),
		DeadLetteredAt:    metadataString(metadata, "deadLetteredAt"),
		DeadLetter:        boolToInt(metadataBool(metadata, "deadLetter")),
		ExecutionSource:   metadataString(metadata, "executionSource"),
		RetryClass:        metadataString(metadata, "retryClass"),
		RetryPolicyTier:   metadataString(metadata, "retryPolicyTier"),
		AttemptsRemaining: attemptsRemaining,
	}, nil
}

func decodeTask(taskJSON string) (ingestion.TaskStatus, error) {
	var task ingestion.TaskStatus
	if err := json.Unmarshal([]byte(taskJSON), &task); err != nil {
		return ingestion.TaskStatus{}, err
	}
	return cloneTask(task), nil
}

func metadataString(metadata map[string]any, key string) string {
	value, _ := metadata[key].(string)
	return strings.TrimSpace(value)
}

func metadataBool(metadata map[string]any, key string) bool {
	value, exists := metadata[key]
	if !exists {
		return false
	}
	typed, ok := value.(bool)
	return ok && typed
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func isTaskRunnable(task ingestion.TaskStatus, now time.Time) bool {
	switch task.Status {
	case ingestion.StatusPending:
		return dueAtOrBefore(task.NextRunAt, now)
	case ingestion.StatusRunning:
		leaseExpiresAt := metadataString(task.Metadata, "leaseExpiresAt")
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

func mergeMaps(base map[string]any, extra map[string]any) map[string]any {
	merged := cloneMap(base)
	for key, value := range extra {
		merged[key] = value
	}
	return merged
}

func cloneMap(source map[string]any) map[string]any {
	if len(source) == 0 {
		return map[string]any{}
	}
	cloned := make(map[string]any, len(source))
	for key, value := range source {
		cloned[key] = value
	}
	return cloned
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

func isDuplicateIndexError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "duplicate key name")
}
