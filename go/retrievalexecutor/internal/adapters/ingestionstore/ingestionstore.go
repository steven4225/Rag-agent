package ingestionstore

import (
	"context"
	"errors"
	"time"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

var ErrTaskNotFound = errors.New("ingestion task not found")
var ErrTaskNotClaimable = errors.New("ingestion task not claimable")

// Repository defines the stable ingestion task persistence boundary.
// Future queue/worker schedulers should only advance task states through this contract.
type Repository interface {
	Upsert(ctx context.Context, task ingestion.TaskStatus) error
	Get(ctx context.Context, taskID string) (ingestion.TaskStatus, error)
	FindByIdempotencyKey(ctx context.Context, idempotencyKey string) (ingestion.TaskStatus, error)
	ListByKnowledgeBase(ctx context.Context, knowledgeBaseID string, limit int) ([]ingestion.TaskStatus, error)
	ListRecent(ctx context.Context, limit int) ([]ingestion.TaskStatus, error)
	ListRunnable(ctx context.Context, now time.Time, limit int) ([]ingestion.TaskStatus, error)
	Claim(ctx context.Context, taskID string, workerID string, now time.Time, leaseDuration time.Duration, force bool) (ingestion.TaskStatus, error)
}
