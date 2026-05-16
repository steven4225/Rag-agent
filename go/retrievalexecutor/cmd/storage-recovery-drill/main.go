package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	indexmetastoreadapter "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexmetastore"
	indexmetastoremysql "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexmetastore/mysqlstore"
	ingestionstoremysql "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestionstore/mysqlstore"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

const (
	modeSeed   = "seed"
	modeVerify = "verify"
)

type output struct {
	Mode             string        `json:"mode"`
	GeneratedAt      string        `json:"generatedAt"`
	Seed             *seedReport   `json:"seed,omitempty"`
	Verification     *verifyReport `json:"verification,omitempty"`
	Warnings         []string      `json:"warnings,omitempty"`
	ExecutionElapsed int64         `json:"executionElapsedMs"`
}

type seedReport struct {
	SeededTaskIDs        []string `json:"seededTaskIds"`
	SeededMetadataRecord []string `json:"seededMetadataRecordIds"`
	KnowledgeBaseID      string   `json:"knowledgeBaseId"`
	DocumentID           string   `json:"documentId"`
}

type verifyReport struct {
	FindByIdempotencyKey struct {
		Passed bool   `json:"passed"`
		TaskID string `json:"taskId"`
	} `json:"findByIdempotencyKey"`
	ListRunnable struct {
		Passed         bool     `json:"passed"`
		RunnableTaskID []string `json:"runnableTaskIds"`
	} `json:"listRunnable"`
	Claim struct {
		Passed       bool   `json:"passed"`
		TaskID       string `json:"taskId"`
		Status       string `json:"status"`
		CurrentStage string `json:"currentStage"`
		ClaimedBy    string `json:"claimedBy"`
		AttemptCount int    `json:"attemptCount"`
	} `json:"claim"`
	DeadLetter struct {
		Passed         bool   `json:"passed"`
		TaskID         string `json:"taskId"`
		TerminalState  string `json:"terminalState"`
		TerminalReason string `json:"terminalReason"`
		DeadLetter     bool   `json:"deadLetter"`
	} `json:"deadLetter"`
	ListByDocument struct {
		Passed    bool     `json:"passed"`
		RecordIDs []string `json:"recordIds"`
	} `json:"listByDocument"`
}

func main() {
	mode := flag.String("mode", "", "mode: seed|verify")
	dsn := flag.String("dsn", strings.TrimSpace(os.Getenv("MYSQL_DSN")), "mysql dsn")
	reportPath := flag.String("report", "", "optional output report file path")
	flag.Parse()

	startedAt := time.Now()
	if strings.TrimSpace(*mode) == "" {
		fatalf("mode is required: seed|verify")
	}
	if strings.TrimSpace(*dsn) == "" {
		fatalf("dsn is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	taskStore, err := ingestionstoremysql.NewStore(ingestionstoremysql.Config{DSN: *dsn})
	if err != nil {
		fatalf("init ingestion mysql store failed: %v", err)
	}
	defer taskStore.Close()

	indexMetadataStore, err := indexmetastoremysql.NewStore(indexmetastoremysql.Config{DSN: *dsn})
	if err != nil {
		fatalf("init index metadata mysql store failed: %v", err)
	}
	defer indexMetadataStore.Close()

	result := output{
		Mode:             strings.ToLower(strings.TrimSpace(*mode)),
		GeneratedAt:      time.Now().UTC().Format(time.RFC3339),
		ExecutionElapsed: 0,
	}

	switch result.Mode {
	case modeSeed:
		seeded, seedErr := runSeed(ctx, taskStore, indexMetadataStore)
		if seedErr != nil {
			fatalf("seed failed: %v", seedErr)
		}
		result.Seed = seeded
	case modeVerify:
		verified, verifyErr := runVerify(ctx, taskStore, indexMetadataStore)
		if verifyErr != nil {
			fatalf("verify failed: %v", verifyErr)
		}
		result.Verification = verified
	default:
		fatalf("unsupported mode: %s", result.Mode)
	}

	result.ExecutionElapsed = time.Since(startedAt).Milliseconds()

	bytes, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fatalf("marshal report failed: %v", err)
	}

	if strings.TrimSpace(*reportPath) != "" {
		if err := os.WriteFile(*reportPath, bytes, 0o644); err != nil {
			fatalf("write report failed: %v", err)
		}
	}

	fmt.Println(string(bytes))
}

func runSeed(
	ctx context.Context,
	taskStore *ingestionstoremysql.Store,
	indexMetadataStore *indexmetastoremysql.Store,
) (*seedReport, error) {
	now := time.Now().UTC()
	nowText := now.Format(time.RFC3339)
	pastRunAt := now.Add(-2 * time.Minute).Format(time.RFC3339)
	expiredLease := now.Add(-3 * time.Minute).Format(time.RFC3339)

	kbID := "kb_recovery"
	docID := "doc_recovery"

	seedTasks := []ingestion.TaskStatus{
		{
			TaskID:          "task-pending-runnable",
			TraceID:         "trace-recovery-001",
			KnowledgeBaseID: kbID,
			DocumentID:      docID,
			Status:          ingestion.StatusPending,
			CurrentStage:    ingestion.StageQueued,
			AttemptCount:    0,
			MaxAttempts:     3,
			Retryable:       true,
			NextRunAt:       pastRunAt,
			CreatedAt:       nowText,
			UpdatedAt:       nowText,
			Metadata: map[string]any{
				"idempotencyKey":  "idem-recovery-001",
				"retryClass":      "transient",
				"retryPolicyTier": "baseline",
				"executionSource": "storage-recovery-drill",
			},
		},
		{
			TaskID:          "task-running-expired",
			TraceID:         "trace-recovery-002",
			KnowledgeBaseID: kbID,
			DocumentID:      docID,
			Status:          ingestion.StatusRunning,
			CurrentStage:    ingestion.StageParser,
			AttemptCount:    1,
			MaxAttempts:     3,
			Retryable:       true,
			CreatedAt:       nowText,
			UpdatedAt:       nowText,
			StartedAt:       now.Add(-5 * time.Minute).Format(time.RFC3339),
			Metadata: map[string]any{
				"idempotencyKey":  "idem-recovery-002",
				"leaseExpiresAt":  expiredLease,
				"claimedBy":       "worker-expired",
				"retryClass":      "transient",
				"retryPolicyTier": "baseline",
				"executionSource": "storage-recovery-drill",
			},
		},
		{
			TaskID:          "task-dead-letter",
			TraceID:         "trace-recovery-003",
			KnowledgeBaseID: kbID,
			DocumentID:      docID,
			Status:          ingestion.StatusFailed,
			CurrentStage:    ingestion.StageFailed,
			AttemptCount:    3,
			MaxAttempts:     3,
			Retryable:       false,
			CreatedAt:       nowText,
			UpdatedAt:       nowText,
			FinishedAt:      nowText,
			Metadata: map[string]any{
				"idempotencyKey":  "idem-recovery-003",
				"terminalState":   "dead-letter",
				"terminalReason":  "manual-drill-seed",
				"deadLetter":      true,
				"deadLetteredAt":  nowText,
				"retryClass":      "terminal",
				"retryPolicyTier": "none",
				"executionSource": "storage-recovery-drill",
			},
		},
	}

	seededTaskIDs := make([]string, 0, len(seedTasks))
	for _, task := range seedTasks {
		if err := taskStore.Upsert(ctx, task); err != nil {
			return nil, err
		}
		seededTaskIDs = append(seededTaskIDs, task.TaskID)
	}
	sort.Strings(seededTaskIDs)

	writeResult, err := indexMetadataStore.Upsert(ctx, indexmetastoreadapter.UpsertRequest{
		TraceID:         "trace-index-recovery-001",
		TaskID:          "task-pending-runnable",
		KnowledgeBaseID: kbID,
		DocumentID:      docID,
		IndexName:       kbID,
		Records: []ingestion.IndexRecord{
			{
				RecordID:        "kb_recovery::doc_recovery::chunk_001",
				KnowledgeBaseID: kbID,
				DocumentID:      docID,
				ChunkID:         "chunk_001",
				ChunkIndex:      0,
				EmbeddingRef:    "embedding-ref-001",
				Source:          "storage-recovery-drill",
				Metadata: map[string]any{
					"section": "overview",
				},
			},
			{
				RecordID:        "kb_recovery::doc_recovery::chunk_002",
				KnowledgeBaseID: kbID,
				DocumentID:      docID,
				ChunkID:         "chunk_002",
				ChunkIndex:      1,
				EmbeddingRef:    "embedding-ref-002",
				Source:          "storage-recovery-drill",
				Metadata: map[string]any{
					"section": "details",
				},
			},
		},
	})
	if err != nil {
		return nil, err
	}

	return &seedReport{
		SeededTaskIDs:        seededTaskIDs,
		SeededMetadataRecord: append([]string{}, writeResult.PersistedRecordIDs...),
		KnowledgeBaseID:      kbID,
		DocumentID:           docID,
	}, nil
}

func runVerify(
	ctx context.Context,
	taskStore *ingestionstoremysql.Store,
	indexMetadataStore *indexmetastoremysql.Store,
) (*verifyReport, error) {
	report := &verifyReport{}

	foundByIdem, err := taskStore.FindByIdempotencyKey(ctx, "idem-recovery-001")
	if err != nil {
		return nil, err
	}
	report.FindByIdempotencyKey.TaskID = foundByIdem.TaskID
	report.FindByIdempotencyKey.Passed = foundByIdem.TaskID == "task-pending-runnable"

	now := time.Now().UTC()
	runnable, err := taskStore.ListRunnable(ctx, now, 20)
	if err != nil {
		return nil, err
	}
	runnableIDs := make([]string, 0, len(runnable))
	for _, task := range runnable {
		runnableIDs = append(runnableIDs, task.TaskID)
	}
	sort.Strings(runnableIDs)
	report.ListRunnable.RunnableTaskID = runnableIDs
	report.ListRunnable.Passed = contains(runnableIDs, "task-pending-runnable") && contains(runnableIDs, "task-running-expired")

	claimed, err := taskStore.Claim(ctx, "task-pending-runnable", "recovery-drill-worker", now, 60*time.Second, false)
	if err != nil {
		return nil, err
	}
	report.Claim.TaskID = claimed.TaskID
	report.Claim.Status = claimed.Status
	report.Claim.CurrentStage = claimed.CurrentStage
	report.Claim.AttemptCount = claimed.AttemptCount
	report.Claim.ClaimedBy = metadataString(claimed.Metadata, "claimedBy")
	report.Claim.Passed = claimed.TaskID == "task-pending-runnable" &&
		claimed.Status == ingestion.StatusRunning &&
		claimed.CurrentStage == ingestion.StageParser &&
		claimed.AttemptCount >= 1 &&
		report.Claim.ClaimedBy == "recovery-drill-worker"

	deadLetterTask, err := taskStore.Get(ctx, "task-dead-letter")
	if err != nil {
		return nil, err
	}
	report.DeadLetter.TaskID = deadLetterTask.TaskID
	report.DeadLetter.TerminalState = metadataString(deadLetterTask.Metadata, "terminalState")
	report.DeadLetter.TerminalReason = metadataString(deadLetterTask.Metadata, "terminalReason")
	report.DeadLetter.DeadLetter = metadataBool(deadLetterTask.Metadata, "deadLetter")
	report.DeadLetter.Passed = report.DeadLetter.TerminalState == "dead-letter" &&
		report.DeadLetter.DeadLetter &&
		strings.TrimSpace(report.DeadLetter.TerminalReason) != ""

	listByDoc, err := indexMetadataStore.ListByDocument(ctx, indexmetastoreadapter.ListByDocumentRequest{
		TraceID:         "trace-index-recovery-verify-001",
		KnowledgeBaseID: "kb_recovery",
		DocumentID:      "doc_recovery",
	})
	if err != nil {
		return nil, err
	}
	recordIDs := make([]string, 0, len(listByDoc.Records))
	for _, record := range listByDoc.Records {
		recordIDs = append(recordIDs, record.RecordID)
	}
	sort.Strings(recordIDs)
	report.ListByDocument.RecordIDs = recordIDs
	report.ListByDocument.Passed = contains(recordIDs, "kb_recovery::doc_recovery::chunk_001") &&
		contains(recordIDs, "kb_recovery::doc_recovery::chunk_002")

	if !report.FindByIdempotencyKey.Passed {
		return nil, fmt.Errorf("FindByIdempotencyKey validation failed")
	}
	if !report.ListRunnable.Passed {
		return nil, fmt.Errorf("ListRunnable validation failed")
	}
	if !report.Claim.Passed {
		return nil, fmt.Errorf("Claim validation failed")
	}
	if !report.DeadLetter.Passed {
		return nil, fmt.Errorf("dead-letter validation failed")
	}
	if !report.ListByDocument.Passed {
		return nil, fmt.Errorf("ListByDocument validation failed")
	}

	return report, nil
}

func contains(items []string, target string) bool {
	for _, item := range items {
		if item == target {
			return true
		}
	}
	return false
}

func metadataString(metadata map[string]any, key string) string {
	if metadata == nil {
		return ""
	}
	value, _ := metadata[key].(string)
	return strings.TrimSpace(value)
}

func metadataBool(metadata map[string]any, key string) bool {
	if metadata == nil {
		return false
	}
	value, exists := metadata[key]
	if !exists {
		return false
	}
	typed, ok := value.(bool)
	return ok && typed
}

func fatalf(format string, args ...any) {
	_, _ = fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
