package worker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	indexstore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexstore"
	ingestionstore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestionstore"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

type IngestionWorker struct {
	parser     ingestion.ParserAdapter
	chunker    ingestion.Chunker
	embedding  ingestion.EmbeddingAdapter
	indexStore indexstore.Adapter
	tasks      ingestionstore.Repository
}

const (
	retryTierNone       = "none"
	retryTierFast       = "fast-backoff"
	retryTierStandard   = "standard-backoff"
	retryTierDependency = "dependency-backoff"
)

func NewIngestionWorker(
	parser ingestion.ParserAdapter,
	chunker ingestion.Chunker,
	embedding ingestion.EmbeddingAdapter,
	indexStore indexstore.Adapter,
	tasks ingestionstore.Repository,
) *IngestionWorker {
	return &IngestionWorker{
		parser:     parser,
		chunker:    chunker,
		embedding:  embedding,
		indexStore: indexStore,
		tasks:      tasks,
	}
}

func (w *IngestionWorker) Execute(ctx context.Context, task ingestion.TaskStatus) (ingestion.TaskStatus, error) {
	task = appendTrace(task, ingestion.StageClaimed, ingestion.StatusRunning, "ingestion worker claimed task", map[string]any{
		"attemptCount": task.AttemptCount,
		"maxAttempts":  task.MaxAttempts,
	})
	if err := w.persistTask(ctx, task); err != nil {
		return task, err
	}

	parseResult, task, err := w.runParser(ctx, task)
	if err != nil {
		return task, nil
	}

	chunks, task, err := w.runChunker(ctx, task, parseResult)
	if err != nil {
		return task, nil
	}

	task, err = w.runEmbedding(ctx, task, chunks)
	if err != nil {
		return task, nil
	}

	task, err = w.runIndexing(ctx, task, chunks)
	if err != nil {
		return task, nil
	}

	now := time.Now().UTC().Format(time.RFC3339)
	task.Status = ingestion.StatusSucceeded
	task.CurrentStage = ingestion.StageCompleted
	task.Retryable = false
	task.NextRunAt = ""
	task.RetryAfterSec = 0
	task.FailureReason = ""
	task.FailureStage = ""
	task.ErrorMessage = ""
	task.UpdatedAt = now
	task.FinishedAt = now
	task.Metadata = mergeMaps(task.Metadata, map[string]any{
		"executionSource":      "go-ingestion-worker",
		"embeddingSource":      resultSource(task.EmbeddingResult),
		"indexingSource":       resultIndexSource(task.IndexWriteResult),
		"indexOperation":       resultIndexOperation(task.IndexWriteResult),
		"indexedChunkCount":    indexedChunkCount(task.IndexWriteResult),
		"indexedRecordCount":   indexedRecordCount(task.IndexWriteResult),
		"skippedRecordCount":   skippedRecordCount(task.IndexWriteResult),
		"replacedRecordCount":  replacedRecordCount(task.IndexWriteResult),
		"deletedRecordCount":   deletedRecordCount(task.IndexWriteResult),
		"retryable":            false,
		"failureStage":         nil,
		"failureReason":        nil,
		"lastCompletedAttempt": task.AttemptCount,
	})
	task = appendTrace(task, ingestion.StageCompleted, ingestion.StatusSucceeded, "ingestion task finished", map[string]any{
		"chunkCount":        len(task.Chunks),
		"indexedChunkCount": indexedChunkCount(task.IndexWriteResult),
		"recordCount":       indexedRecordCount(task.IndexWriteResult),
	})

	if err := w.persistTask(ctx, task); err != nil {
		return task, err
	}
	return task, nil
}

func (w *IngestionWorker) runParser(ctx context.Context, task ingestion.TaskStatus) (ingestion.ParseResult, ingestion.TaskStatus, error) {
	task.CurrentStage = ingestion.StageParser
	task.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	task = appendTrace(task, "parsing", ingestion.StatusRunning, "parser stage started", map[string]any{
		"parserType": task.ExecutionPlan.Parser.ParserType,
	})
	if err := w.persistTask(ctx, task); err != nil {
		return ingestion.ParseResult{}, task, err
	}

	parseResult, err := w.parser.Parse(ctx, ingestion.ParseRequest{
		TaskID:          task.TaskID,
		TraceID:         task.TraceID,
		DocumentID:      task.DocumentID,
		KnowledgeBaseID: task.KnowledgeBaseID,
		Source:          task.Source,
		Plan:            task.ExecutionPlan,
	})
	if err != nil {
		retryable, errorSource, errorCode := classifyParserError(err)
		task = w.markTaskFailed(task, ingestion.StageParser, err.Error(), retryable, errorSource, map[string]any{
			"parserErrorCode": errorCode,
			"parserBackend":   "unknown",
		})
		if persistErr := w.persistTask(ctx, task); persistErr != nil {
			slog.Error("persist task failed", "error", persistErr, "taskId", task.TaskID)
		}
		return ingestion.ParseResult{}, task, err
	}
	if parseResult.ParsedDocument == nil {
		task = w.markTaskFailed(task, ingestion.StageParser, "parser completed without parsed document", false, "parser-adapter", nil)
		_ = w.persistTask(ctx, task)
		return ingestion.ParseResult{}, task, fmt.Errorf("parser completed without parsed document")
	}

	task.ParserResult = &parseResult
	parserMetadata := map[string]any{
		"parserBackend": parseResult.ParserBackend,
		"parserName":    parseResult.ParserName,
		"parserVersion": parseResult.ParserVersion,
	}
	if parseResult.ParsedDocument != nil {
		if fallbackReason, ok := parseResult.ParsedDocument.Metadata["fallbackReason"]; ok {
			parserMetadata["fallbackReason"] = fallbackReason
		}
		if tikaURL, ok := parseResult.ParsedDocument.Metadata["tikaUrl"]; ok {
			parserMetadata["tikaUrl"] = tikaURL
		}
		if tikaContentType, ok := parseResult.ParsedDocument.Metadata["tikaContentType"]; ok {
			parserMetadata["tikaContentType"] = tikaContentType
		}
		if tikaMetadataKeys, ok := parseResult.ParsedDocument.Metadata["tikaMetadataKeys"]; ok {
			parserMetadata["tikaMetadataKeys"] = tikaMetadataKeys
		}
	}
	task.Metadata = mergeMaps(task.Metadata, parserMetadata)
	task = appendTrace(task, "parsing", ingestion.StatusSucceeded, "parser adapter completed", map[string]any{
		"parserBackend":    parseResult.ParserBackend,
		"parserName":       parseResult.ParserName,
		"parserVersion":    parseResult.ParserVersion,
		"charCount":        parseResult.ParsedDocument.CharCount,
		"fallbackReason":   parserMetadata["fallbackReason"],
		"tikaUrl":          parserMetadata["tikaUrl"],
		"tikaContentType":  parserMetadata["tikaContentType"],
		"tikaMetadataKeys": parserMetadata["tikaMetadataKeys"],
	})
	if err := w.persistTask(ctx, task); err != nil {
		return ingestion.ParseResult{}, task, err
	}
	return parseResult, task, nil
}

func (w *IngestionWorker) runChunker(ctx context.Context, task ingestion.TaskStatus, parseResult ingestion.ParseResult) ([]ingestion.Chunk, ingestion.TaskStatus, error) {
	task.CurrentStage = ingestion.StageChunker
	task.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	task = appendTrace(task, "chunking", ingestion.StatusRunning, "chunking stage started", map[string]any{
		"strategy": task.ExecutionPlan.Chunking.Strategy,
	})
	if err := w.persistTask(ctx, task); err != nil {
		return nil, task, err
	}

	chunks, chunkDurationMs, chunkErr := w.chunker.Split(ctx, *parseResult.ParsedDocument, task.ExecutionPlan.Chunking)
	if chunkErr != nil {
		task = w.markTaskFailed(task, ingestion.StageChunker, chunkErr.Error(), false, "chunker", nil)
		_ = w.persistTask(ctx, task)
		return nil, task, chunkErr
	}

	task.Chunks = chunks
	if task.ParserResult != nil {
		task.ParserResult.Metrics.ChunkDurationMs = chunkDurationMs
	}
	task = appendTrace(task, "chunking", ingestion.StatusSucceeded, "chunker emitted chunk payloads", map[string]any{
		"chunkCount": len(chunks),
		"strategy":   task.ExecutionPlan.Chunking.Strategy,
	})
	if err := w.persistTask(ctx, task); err != nil {
		return nil, task, err
	}
	return chunks, task, nil
}

func (w *IngestionWorker) runEmbedding(ctx context.Context, task ingestion.TaskStatus, chunks []ingestion.Chunk) (ingestion.TaskStatus, error) {
	task.CurrentStage = ingestion.StageEmbedding
	task.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	request := buildEmbeddingRequest(task, chunks)
	task = appendTrace(task, "embedding", ingestion.StatusRunning, "embedding stage started", map[string]any{
		"enabled":  task.ExecutionPlan.Embedding.Enabled,
		"provider": strings.TrimSpace(task.ExecutionPlan.Embedding.Adapter),
		"model":    request.Model,
	})
	if err := w.persistTask(ctx, task); err != nil {
		return task, err
	}

	if !task.ExecutionPlan.Embedding.Enabled {
		task = appendTrace(task, "embedding", ingestion.StatusPending, "embedding stage disabled by execution plan", map[string]any{
			"enabled": false,
		})
		return task, w.persistTask(ctx, task)
	}

	startedAt := time.Now()
	embeddingResult, embeddingErr := w.embedding.Embed(ctx, request)
	durationMs := time.Since(startedAt).Milliseconds()
	if embeddingErr != nil {
		retryable, errorSource, fallbackReason, providerName, modelName := classifyEmbeddingError(embeddingErr, request)
		task = appendTrace(task, "embedding", ingestion.StatusFailed, "embedding adapter failed", map[string]any{
			"provider":         providerName,
			"model":            modelName,
			"vectorDimensions": 0,
			"fallbackReason":   fallbackReason,
			"retryable":        retryable,
		})
		task = w.markTaskFailed(task, ingestion.StageEmbedding, embeddingErr.Error(), retryable, errorSource, map[string]any{
			"embeddingProvider":   providerName,
			"embeddingModel":      modelName,
			"vectorDimensions":    0,
			"embeddingDurationMs": durationMs,
			"fallbackReason":      fallbackReason,
		})
		if persistErr := w.persistTask(ctx, task); persistErr != nil {
			slog.Error("persist task failed", "error", persistErr, "taskId", task.TaskID)
		}
		return task, embeddingErr
	}

	embeddingProvider := metadataString(embeddingResult.Metadata, "embeddingProvider", task.ExecutionPlan.Embedding.Adapter)
	embeddingModel := metadataString(embeddingResult.Metadata, "embeddingModel", embeddingResult.Model)
	fallbackReason := metadataString(embeddingResult.Metadata, "fallbackReason", "")
	embeddingResult.Metadata = mergeMaps(embeddingResult.Metadata, map[string]any{
		"embeddingProvider":   embeddingProvider,
		"embeddingModel":      embeddingModel,
		"vectorDimensions":    embeddingResult.Dimensions,
		"embeddingDurationMs": durationMs,
		"fallbackReason":      fallbackReason,
	})
	task.EmbeddingResult = &embeddingResult
	task.Metadata = mergeMaps(task.Metadata, map[string]any{
		"embeddingProvider":   embeddingProvider,
		"embeddingModel":      embeddingModel,
		"vectorDimensions":    embeddingResult.Dimensions,
		"embeddingSource":     embeddingResult.Source,
		"embeddingDurationMs": durationMs,
		"fallbackReason":      fallbackReason,
	})
	task = appendTrace(task, "embedding", ingestion.StatusSucceeded, "embedding adapter produced artifacts", map[string]any{
		"provider":         embeddingProvider,
		"model":            embeddingModel,
		"vectorCount":      embeddingResult.VectorCount,
		"vectorDimensions": embeddingResult.Dimensions,
		"fallbackReason":   fallbackReason,
		"retryable":        false,
	})
	return task, w.persistTask(ctx, task)
}

func (w *IngestionWorker) runIndexing(ctx context.Context, task ingestion.TaskStatus, chunks []ingestion.Chunk) (ingestion.TaskStatus, error) {
	task.CurrentStage = ingestion.StageIndexing
	task.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	task = appendTrace(task, "indexing", ingestion.StatusRunning, "indexing stage started", map[string]any{
		"enabled": task.ExecutionPlan.Indexing.Enabled,
	})
	if err := w.persistTask(ctx, task); err != nil {
		return task, err
	}

	if !task.ExecutionPlan.Indexing.Enabled {
		task = appendTrace(task, "indexing", ingestion.StatusPending, "indexing stage disabled by execution plan", map[string]any{
			"enabled": false,
		})
		return task, w.persistTask(ctx, task)
	}

	indexWriteRequest := buildIndexWriteRequest(task)
	deleteResult, deleteErr := w.indexStore.DeleteByDocument(ctx, indexstore.DeleteByDocumentRequest{
		TraceID:         task.TraceID,
		KnowledgeBaseID: task.KnowledgeBaseID,
		DocumentID:      task.DocumentID,
		Metadata: map[string]any{
			"stage":          ingestion.StageIndexing,
			"idempotencyKey": indexWriteRequest.IdempotencyKey,
		},
	})
	if deleteErr != nil {
		retryable, errorSource := classifyIndexError(deleteErr, "index-store")
		task = w.markTaskFailed(task, ingestion.StageIndexing, deleteErr.Error(), retryable, errorSource, map[string]any{
			"indexOperation": indexstore.OperationDeleteByDocument,
		})
		if persistErr := w.persistTask(ctx, task); persistErr != nil {
			slog.Error("persist task failed", "error", persistErr, "taskId", task.TaskID)
		}
		return task, deleteErr
	}

	indexWriteResult, indexErr := w.indexStore.Upsert(ctx, toIndexUpsertRequest(indexWriteRequest))
	if indexErr != nil {
		retryable, errorSource := classifyIndexError(indexErr, "index-store")
		task = w.markTaskFailed(task, ingestion.StageIndexing, indexErr.Error(), retryable, errorSource, map[string]any{
			"indexOperation": indexstore.OperationUpsert,
		})
		_ = w.persistTask(ctx, task)
		return task, indexErr
	}

	task.IndexWriteResult = &ingestion.IndexWriteResult{
		Status:              indexWriteResult.Status,
		IndexName:           indexWriteResult.IndexName,
		StoreType:           indexWriteResult.StoreType,
		Source:              indexWriteResult.Source,
		Operation:           indexWriteResult.Operation,
		RecordCount:         indexWriteResult.RecordCount,
		IndexedChunkCount:   indexWriteResult.IndexedChunkCount,
		SkippedRecordCount:  indexWriteResult.SkippedRecordCount,
		ReplacedRecordCount: indexWriteResult.ReplacedRecordCount,
		DeletedRecordCount:  deleteResult.DeletedRecordCount + indexWriteResult.DeletedRecordCount,
		Records:             indexWriteResult.Records,
		ErrorMessage:        indexWriteResult.ErrorMessage,
		Metadata: mergeMaps(indexWriteResult.Metadata, map[string]any{
			"idempotencyKey":      indexWriteRequest.IdempotencyKey,
			"indexOperation":      indexWriteResult.Operation,
			"deletedBeforeUpsert": deleteResult.DeletedRecordCount,
		}),
	}
	task = appendTrace(task, "indexing", ingestion.StatusSucceeded, "index store persisted placeholder records", map[string]any{
		"recordCount":         indexWriteResult.RecordCount,
		"indexedChunkCount":   indexWriteResult.IndexedChunkCount,
		"skippedRecordCount":  indexWriteResult.SkippedRecordCount,
		"replacedRecordCount": indexWriteResult.ReplacedRecordCount,
		"deletedRecordCount":  deleteResult.DeletedRecordCount,
		"storeType":           indexWriteResult.StoreType,
		"source":              indexWriteResult.Source,
	})
	return task, w.persistTask(ctx, task)
}

func (w *IngestionWorker) persistTask(ctx context.Context, task ingestion.TaskStatus) error {
	return w.tasks.Upsert(ctx, task)
}

func (w *IngestionWorker) markTaskFailed(
	task ingestion.TaskStatus,
	failureStage string,
	failureReason string,
	retryable bool,
	errorSource string,
	extraMetadata map[string]any,
) ingestion.TaskStatus {
	now := time.Now().UTC()
	nowText := now.Format(time.RFC3339)
	maxAttempts := maxAttempts(task)
	attemptsRemaining := maxAttempts - task.AttemptCount
	if attemptsRemaining < 0 {
		attemptsRemaining = 0
	}
	retryClass := classifyRetryClass(failureStage, retryable, errorSource, failureReason)
	retryTier := resolveRetryTier(retryClass, retryable)
	effectiveRetryTier := retryTier

	task.UpdatedAt = nowText
	task.ErrorMessage = failureReason
	task.FailureReason = failureReason
	task.FailureStage = failureStage

	allowRetry := retryable && attemptsRemaining > 0
	if allowRetry {
		retryDelay := nextRetryDelay(task.AttemptCount, retryTier)
		task.Status = ingestion.StatusPending
		task.CurrentStage = ingestion.StageQueued
		task.Retryable = true
		task.RetryAfterSec = int(retryDelay.Seconds())
		task.NextRunAt = now.Add(retryDelay).Format(time.RFC3339)
		task.FinishedAt = ""
		task = appendTrace(task, ingestion.StageFailed, ingestion.StatusFailed, "ingestion stage failed", map[string]any{
			"failureStage":      failureStage,
			"failureReason":     failureReason,
			"retryable":         true,
			"errorSource":       errorSource,
			"retryClass":        retryClass,
			"retryPolicyTier":   retryTier,
			"attemptCount":      task.AttemptCount,
			"maxAttempts":       maxAttempts,
			"attemptsRemaining": attemptsRemaining,
		})
		task = appendTrace(task, ingestion.StageRetry, ingestion.StatusPending, "retry scheduled for failed ingestion task", map[string]any{
			"nextRunAt":         task.NextRunAt,
			"retryAfterSec":     task.RetryAfterSec,
			"attemptCount":      task.AttemptCount,
			"maxAttempts":       maxAttempts,
			"attemptsRemaining": attemptsRemaining,
			"retryClass":        retryClass,
			"retryPolicyTier":   retryTier,
		})
	} else {
		effectiveRetryTier = retryTierNone
		task.Status = ingestion.StatusFailed
		task.CurrentStage = ingestion.StageFailed
		task.Retryable = false
		task.RetryAfterSec = 0
		task.NextRunAt = ""
		task.FinishedAt = nowText
		terminalState := "terminal-failure"
		terminalReason := "non-retryable-error"
		deadLetter := false
		if retryable && attemptsRemaining == 0 {
			terminalState = "dead-letter"
			terminalReason = "max-attempts-exhausted"
			deadLetter = true
		}
		task = appendTrace(task, ingestion.StageFailed, ingestion.StatusFailed, "ingestion stage failed", map[string]any{
			"failureStage":      failureStage,
			"failureReason":     failureReason,
			"retryable":         false,
			"errorSource":       errorSource,
			"retryClass":        retryClass,
			"retryPolicyTier":   retryTierNone,
			"attemptCount":      task.AttemptCount,
			"maxAttempts":       maxAttempts,
			"attemptsRemaining": attemptsRemaining,
			"terminalState":     terminalState,
			"terminalReason":    terminalReason,
			"deadLetter":        deadLetter,
		})
		task.Metadata = mergeMaps(task.Metadata, map[string]any{
			"terminalState":          terminalState,
			"terminalReason":         terminalReason,
			"terminalAt":             nowText,
			"deadLetter":             deadLetter,
			"deadLetteredAt":         nil,
			"deadLetterFailureStage": failureStage,
		})
		if deadLetter {
			task.Metadata["deadLetteredAt"] = nowText
		}
	}
	task.Metadata = mergeMaps(task.Metadata, map[string]any{
		"retryable":            task.Retryable,
		"nextRunAt":            task.NextRunAt,
		"retryAfterSec":        task.RetryAfterSec,
		"failureStage":         failureStage,
		"failureReason":        failureReason,
		"errorSource":          errorSource,
		"retryClass":           retryClass,
		"retryPolicyTier":      effectiveRetryTier,
		"attemptCount":         task.AttemptCount,
		"maxAttempts":          maxAttempts,
		"attemptsRemaining":    attemptsRemaining,
		"lastErrorAt":          nowText,
		"lastErrorMessage":     failureReason,
		"lastFailureStage":     failureStage,
		"lastFailureSource":    errorSource,
		"lastFailureRetryable": task.Retryable,
	})
	if allowRetry {
		task.Metadata = mergeMaps(task.Metadata, map[string]any{
			"terminalState":          nil,
			"terminalReason":         nil,
			"terminalAt":             nil,
			"deadLetter":             false,
			"deadLetteredAt":         nil,
			"deadLetterFailureStage": nil,
		})
	}
	if len(extraMetadata) > 0 {
		task.Metadata = mergeMaps(task.Metadata, extraMetadata)
	}
	return task
}

func maxAttempts(task ingestion.TaskStatus) int {
	if task.MaxAttempts <= 0 {
		return 3
	}
	return task.MaxAttempts
}

func nextRetryDelay(attemptCount int, tier string) time.Duration {
	if attemptCount < 1 {
		attemptCount = 1
	}
	switch tier {
	case retryTierDependency:
		seconds := 15 * attemptCount
		if seconds > 300 {
			seconds = 300
		}
		return time.Duration(seconds) * time.Second
	case retryTierFast:
		seconds := 3 * attemptCount
		if seconds > 30 {
			seconds = 30
		}
		return time.Duration(seconds) * time.Second
	default:
		seconds := 5 * attemptCount
		if seconds > 90 {
			seconds = 90
		}
		return time.Duration(seconds) * time.Second
	}
}

func resolveRetryTier(retryClass string, retryable bool) string {
	if !retryable {
		return retryTierNone
	}
	switch retryClass {
	case "dependency-transient":
		return retryTierDependency
	case "store-transient":
		return retryTierFast
	default:
		return retryTierStandard
	}
}

func classifyRetryClass(failureStage string, retryable bool, errorSource string, failureReason string) string {
	if !retryable {
		return "non-retryable"
	}
	sourceText := strings.ToLower(strings.TrimSpace(errorSource))
	reasonText := strings.ToLower(strings.TrimSpace(failureReason))
	if strings.Contains(sourceText, "qdrant") || strings.Contains(sourceText, "openai") || strings.Contains(sourceText, "tika") {
		return "dependency-transient"
	}
	if strings.Contains(sourceText, "store") || strings.Contains(sourceText, "index") || strings.Contains(sourceText, "file") {
		return "store-transient"
	}
	if strings.Contains(reasonText, "timeout") || strings.Contains(reasonText, "temporar") || strings.Contains(reasonText, "unavailable") {
		return "dependency-transient"
	}
	switch failureStage {
	case ingestion.StageEmbedding, ingestion.StageIndexing:
		return "dependency-transient"
	default:
		return "transient"
	}
}

func appendTrace(task ingestion.TaskStatus, stage string, status string, message string, metadata map[string]any) ingestion.TaskStatus {
	level := "info"
	if status == ingestion.StatusFailed {
		level = "error"
	}
	task.Trace = append(task.Trace, ingestion.TraceEvent{
		TraceID:   task.TraceID,
		TaskID:    task.TaskID,
		Stage:     stage,
		Level:     level,
		Status:    status,
		Message:   message,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Metadata:  cloneMap(metadata),
	})
	return task
}

func buildEmbeddingRequest(task ingestion.TaskStatus, chunks []ingestion.Chunk) ingestion.EmbeddingRequest {
	model := strings.TrimSpace(task.ExecutionPlan.Embedding.Model)
	if model == "" {
		model = "mock-embedding-v1"
	}

	inputs := make([]ingestion.EmbeddingInput, 0, len(chunks))
	for _, chunk := range chunks {
		inputs = append(inputs, ingestion.EmbeddingInput{
			ChunkID:     chunk.ChunkID,
			DocumentID:  chunk.DocumentID,
			ChunkIndex:  chunk.ChunkIndex,
			Text:        chunk.Text,
			CharCount:   chunk.CharCount,
			ContentHash: hashChunk(chunk),
			Metadata:    chunk.Metadata,
			KnowledgeRef: map[string]any{
				"knowledgeBaseId": task.KnowledgeBaseID,
				"documentId":      task.DocumentID,
			},
		})
	}

	return ingestion.EmbeddingRequest{
		TraceID:         task.TraceID,
		TaskID:          task.TaskID,
		KnowledgeBaseID: task.KnowledgeBaseID,
		DocumentID:      task.DocumentID,
		Model:           model,
		Inputs:          inputs,
		Metadata: map[string]any{
			"adapter": task.ExecutionPlan.Embedding.Adapter,
		},
	}
}

func buildIndexWriteRequest(task ingestion.TaskStatus) ingestion.IndexWriteRequest {
	artifacts := map[string]ingestion.EmbeddingArtifact{}
	embeddingProvider := "not-executed"
	embeddingModel := "not-executed"
	embeddingSource := "not-executed"
	embeddingDurationMs := int64(0)
	vectorDimensions := 0
	if task.EmbeddingResult != nil {
		embeddingProvider = metadataString(task.EmbeddingResult.Metadata, "embeddingProvider", "")
		if embeddingProvider == "" {
			embeddingProvider = metadataString(task.Metadata, "embeddingProvider", "")
		}
		if embeddingProvider == "" {
			embeddingProvider = "unknown"
		}
		embeddingModel = metadataString(task.EmbeddingResult.Metadata, "embeddingModel", task.EmbeddingResult.Model)
		embeddingSource = task.EmbeddingResult.Source
		embeddingDurationMs = metadataInt64(task.EmbeddingResult.Metadata, "embeddingDurationMs", 0)
		vectorDimensions = task.EmbeddingResult.Dimensions
		for _, artifact := range task.EmbeddingResult.Artifacts {
			artifacts[artifact.ChunkID] = artifact
		}
	}

	title := task.DocumentID
	if task.ParserResult != nil && task.ParserResult.ParsedDocument != nil && strings.TrimSpace(task.ParserResult.ParsedDocument.Title) != "" {
		title = task.ParserResult.ParsedDocument.Title
	}

	indexName := strings.TrimSpace(task.ExecutionPlan.Indexing.IndexName)
	if indexName == "" {
		indexName = task.KnowledgeBaseID
	}

	records := make([]ingestion.IndexRecord, 0, len(task.Chunks))
	for _, chunk := range task.Chunks {
		artifact := artifacts[chunk.ChunkID]
		records = append(records, ingestion.IndexRecord{
			RecordID:        fmt.Sprintf("%s::%s", task.KnowledgeBaseID, chunk.ChunkID),
			KnowledgeBaseID: task.KnowledgeBaseID,
			DocumentID:      task.DocumentID,
			ChunkID:         chunk.ChunkID,
			ChunkIndex:      chunk.ChunkIndex,
			Title:           title,
			Content:         chunk.Text,
			EmbeddingRef:    artifact.EmbeddingRef,
			Vector:          append([]float32{}, artifact.Vector...),
			Source:          "go-ingestion-index-record",
			TenantID:        metadataString(task.Metadata, "tenantId", ""),
			OrgID:           metadataString(task.Metadata, "orgId", ""),
			Metadata: map[string]any{
				"sectionPath":         append([]string{}, chunk.Metadata.SectionPath...),
				"startOffset":         chunk.Metadata.StartOffset,
				"endOffset":           chunk.Metadata.EndOffset,
				"embeddingProvider":   embeddingProvider,
				"embeddingModel":      embeddingModel,
				"vectorDimensions":    vectorDimensions,
				"embeddingSource":     embeddingSource,
				"embeddingDurationMs": embeddingDurationMs,
			"ingestedAt":        task.CreatedAt,
			"documentUpdatedAt": task.UpdatedAt,
			},
		})
	}

	return ingestion.IndexWriteRequest{
		TraceID:         task.TraceID,
		TaskID:          task.TaskID,
		KnowledgeBaseID: task.KnowledgeBaseID,
		DocumentID:      task.DocumentID,
		IndexName:       indexName,
		Operation:       indexstore.OperationUpsert,
		IdempotencyKey:  resolveTaskIdempotencyKey(task),
		Records:         records,
		Metadata: map[string]any{
			"storeType":      task.ExecutionPlan.Indexing.StoreType,
			"placeholder":    true,
			"indexOperation": indexstore.OperationUpsert,
		},
	}
}

func toIndexUpsertRequest(request ingestion.IndexWriteRequest) indexstore.UpsertRequest {
	return indexstore.UpsertRequest{
		TraceID:         request.TraceID,
		TaskID:          request.TaskID,
		KnowledgeBaseID: request.KnowledgeBaseID,
		DocumentID:      request.DocumentID,
		IndexName:       request.IndexName,
		Operation:       request.Operation,
		IdempotencyKey:  request.IdempotencyKey,
		Records:         request.Records,
		Metadata:        cloneMap(request.Metadata),
	}
}

func classifyIndexError(err error, defaultSource string) (bool, string) {
	source := defaultSource
	retryable := false

	if writeErr, ok := indexstore.IsWriteError(err); ok {
		retryable = writeErr.IsRetryable()
		if strings.TrimSpace(writeErr.ErrorSource()) != "" {
			source = writeErr.ErrorSource()
		}
		return retryable, source
	}
	if readErr, ok := indexstore.IsReadError(err); ok {
		retryable = readErr.IsRetryable()
		if strings.TrimSpace(readErr.ErrorSource()) != "" {
			source = readErr.ErrorSource()
		}
		return retryable, source
	}

	return retryable, source
}

func resolveTaskIdempotencyKey(task ingestion.TaskStatus) string {
	if value, ok := task.Metadata["idempotencyKey"].(string); ok {
		return strings.TrimSpace(value)
	}
	sum := sha256.Sum256([]byte(strings.Join([]string{
		strings.TrimSpace(task.KnowledgeBaseID),
		strings.TrimSpace(task.DocumentID),
		strings.TrimSpace(task.Source.SourceType),
		strings.TrimSpace(task.Source.URI),
		strings.TrimSpace(task.Source.Filename),
	}, "|")))
	return hex.EncodeToString(sum[:])
}

func hashChunk(chunk ingestion.Chunk) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%s|%d|%d", chunk.ChunkID, chunk.Text, chunk.Metadata.StartOffset, chunk.Metadata.EndOffset)))
	return hex.EncodeToString(sum[:])
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

func resultSource(result *ingestion.EmbeddingResult) string {
	if result == nil {
		return "not-executed"
	}
	return result.Source
}

func resultIndexSource(result *ingestion.IndexWriteResult) string {
	if result == nil {
		return "not-executed"
	}
	return result.Source
}

func indexedChunkCount(result *ingestion.IndexWriteResult) int {
	if result == nil {
		return 0
	}
	return result.IndexedChunkCount
}

func indexedRecordCount(result *ingestion.IndexWriteResult) int {
	if result == nil {
		return 0
	}
	return result.RecordCount
}

func skippedRecordCount(result *ingestion.IndexWriteResult) int {
	if result == nil {
		return 0
	}
	return result.SkippedRecordCount
}

func replacedRecordCount(result *ingestion.IndexWriteResult) int {
	if result == nil {
		return 0
	}
	return result.ReplacedRecordCount
}

func deletedRecordCount(result *ingestion.IndexWriteResult) int {
	if result == nil {
		return 0
	}
	return result.DeletedRecordCount
}

func resultIndexOperation(result *ingestion.IndexWriteResult) string {
	if result == nil {
		return "not-executed"
	}
	return result.Operation
}

func classifyEmbeddingError(err error, request ingestion.EmbeddingRequest) (bool, string, string, string, string) {
	retryable := true
	source := "embedding-adapter"
	reason := ""
	providerName := metadataString(request.Metadata, "adapter", "")
	modelName := strings.TrimSpace(request.Model)

	type retryableError interface{ IsRetryable() bool }
	type sourceError interface{ ErrorSource() string }
	type reasonError interface{ ErrorReason() string }
	type providerError interface{ ErrorProvider() string }
	type modelError interface{ ErrorModel() string }

	var targetRetryable retryableError
	if errors.As(err, &targetRetryable) {
		retryable = targetRetryable.IsRetryable()
	}
	var targetSource sourceError
	if errors.As(err, &targetSource) && strings.TrimSpace(targetSource.ErrorSource()) != "" {
		source = strings.TrimSpace(targetSource.ErrorSource())
	}
	var targetReason reasonError
	if errors.As(err, &targetReason) && strings.TrimSpace(targetReason.ErrorReason()) != "" {
		reason = strings.TrimSpace(targetReason.ErrorReason())
	}
	var targetProvider providerError
	if errors.As(err, &targetProvider) && strings.TrimSpace(targetProvider.ErrorProvider()) != "" {
		providerName = strings.TrimSpace(targetProvider.ErrorProvider())
	}
	var targetModel modelError
	if errors.As(err, &targetModel) && strings.TrimSpace(targetModel.ErrorModel()) != "" {
		modelName = strings.TrimSpace(targetModel.ErrorModel())
	}
	if reason == "" {
		reason = "provider-request-failed"
	}
	return retryable, source, reason, providerName, modelName
}

func classifyParserError(err error) (bool, string, string) {
	retryable := false
	source := "parser-adapter"
	code := "parse-failed"

	type retryableError interface{ IsRetryable() bool }
	type sourceError interface{ ErrorSource() string }
	type codeError interface{ ErrorCode() string }

	var targetRetryable retryableError
	if errors.As(err, &targetRetryable) {
		retryable = targetRetryable.IsRetryable()
	}
	var targetSource sourceError
	if errors.As(err, &targetSource) && strings.TrimSpace(targetSource.ErrorSource()) != "" {
		source = strings.TrimSpace(targetSource.ErrorSource())
	}
	var targetCode codeError
	if errors.As(err, &targetCode) && strings.TrimSpace(targetCode.ErrorCode()) != "" {
		code = strings.TrimSpace(targetCode.ErrorCode())
	}
	return retryable, source, code
}

func metadataString(metadata map[string]any, key string, fallback string) string {
	if value, ok := metadata[key].(string); ok && strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return fallback
}

func metadataInt64(metadata map[string]any, key string, fallback int64) int64 {
	value, ok := metadata[key]
	if !ok {
		return fallback
	}
	switch typed := value.(type) {
	case int64:
		return typed
	case int:
		return int64(typed)
	case float64:
		return int64(typed)
	case float32:
		return int64(typed)
	}
	return fallback
}
