package scheduler

import (
	"context"
	"errors"
	"log/slog"
	"time"

	ingestionstore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestionstore"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/application/worker"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

type IngestionRunner struct {
	tasks         ingestionstore.Repository
	worker        *worker.IngestionWorker
	workerID      string
	leaseDuration time.Duration
	loopInterval  time.Duration
	defaultLimit  int
}

type RunSummary struct {
	Scanned   int `json:"scanned"`
	Claimed   int `json:"claimed"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
	Pending   int `json:"pending"`
}

func NewIngestionRunner(
	tasks ingestionstore.Repository,
	worker *worker.IngestionWorker,
	workerID string,
	leaseDuration time.Duration,
	loopInterval time.Duration,
	defaultLimit int,
) *IngestionRunner {
	if leaseDuration <= 0 {
		leaseDuration = 30 * time.Second
	}
	if loopInterval <= 0 {
		loopInterval = 2 * time.Second
	}
	if defaultLimit <= 0 {
		defaultLimit = 4
	}
	return &IngestionRunner{
		tasks:         tasks,
		worker:        worker,
		workerID:      workerID,
		leaseDuration: leaseDuration,
		loopInterval:  loopInterval,
		defaultLimit:  defaultLimit,
	}
}

func (r *IngestionRunner) RunOnce(ctx context.Context, limit int) (RunSummary, error) {
	if limit <= 0 {
		limit = r.defaultLimit
	}
	now := time.Now().UTC()
	runnable, err := r.tasks.ListRunnable(ctx, now, limit)
	if err != nil {
		return RunSummary{}, err
	}

	summary := RunSummary{
		Scanned: len(runnable),
	}
	for _, candidate := range runnable {
		claimed, claimErr := r.tasks.Claim(ctx, candidate.TaskID, r.workerID, now, r.leaseDuration, false)
		if claimErr != nil {
			if errors.Is(claimErr, ingestionstore.ErrTaskNotClaimable) || errors.Is(claimErr, ingestionstore.ErrTaskNotFound) {
				continue
			}
			return summary, claimErr
		}

		summary.Claimed += 1
		finished, execErr := r.worker.Execute(ctx, claimed)
		if execErr != nil {
			return summary, execErr
		}

		switch finished.Status {
		case ingestion.StatusSucceeded:
			summary.Succeeded += 1
		case ingestion.StatusFailed:
			summary.Failed += 1
		case ingestion.StatusPending:
			summary.Pending += 1
		}
	}

	return summary, nil
}

func (r *IngestionRunner) RunTask(ctx context.Context, taskID string) (ingestion.TaskStatus, error) {
	now := time.Now().UTC()
	claimed, err := r.tasks.Claim(ctx, taskID, r.workerID, now, r.leaseDuration, true)
	if err != nil {
		return ingestion.TaskStatus{}, err
	}
	return r.worker.Execute(ctx, claimed)
}

func (r *IngestionRunner) StartBackgroundLoop(ctx context.Context) {
	ticker := time.NewTicker(r.loopInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := r.RunOnce(ctx, r.defaultLimit); err != nil {
				slog.Error("ingestion runner loop failed", "error", err)
			}
		}
	}
}
