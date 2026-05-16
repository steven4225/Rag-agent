package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	indexstore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexstore"
	ingestionstore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestionstore"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
	"github.com/nageoffer/ragent/go/retrievalexecutor/pkg/contracts"
)

var ErrInvalidIngestionRequest = errors.New("invalid ingestion request")

type IngestionService struct {
	parser     ingestion.ParserAdapter
	chunker    ingestion.Chunker
	embedding  ingestion.EmbeddingAdapter
	indexStore indexstore.Adapter
	tasks      ingestionstore.Repository
}

func NewIngestionService(
	parser ingestion.ParserAdapter,
	chunker ingestion.Chunker,
	embedding ingestion.EmbeddingAdapter,
	indexStore indexstore.Adapter,
	tasks ingestionstore.Repository,
) *IngestionService {
	return &IngestionService{
		parser:     parser,
		chunker:    chunker,
		embedding:  embedding,
		indexStore: indexStore,
		tasks:      tasks,
	}
}

func (s *IngestionService) CreateTask(ctx context.Context, request contracts.IngestionTaskCreateRequest) (contracts.IngestionTaskStatusResponse, error) {
	if strings.TrimSpace(request.TraceID) == "" ||
		strings.TrimSpace(request.KnowledgeBaseID) == "" ||
		strings.TrimSpace(request.DocumentID) == "" ||
		strings.TrimSpace(request.Source.Filename) == "" ||
		strings.TrimSpace(request.Source.URI) == "" {
		return contracts.IngestionTaskStatusResponse{}, ErrInvalidIngestionRequest
	}

	now := time.Now().UTC()
	requestIdentity := computeRequestIdentity(request)
	idempotencyKey := computeIdempotencyKey(request.KnowledgeBaseID, request.DocumentID, requestIdentity)
	if existingTask, existingErr := s.tasks.FindByIdempotencyKey(ctx, idempotencyKey); existingErr == nil {
		existingTask.Trace = append(existingTask.Trace, traceEvent(request.TraceID, existingTask.TaskID, "accepted", existingTask.Status, "idempotent task request reused existing task", map[string]any{
			"idempotencyKey": idempotencyKey,
			"reusedTaskId":   existingTask.TaskID,
			"existingStatus": existingTask.Status,
		}))
		existingTask.UpdatedAt = now.Format(time.RFC3339)
		existingTask.Metadata = mergeMaps(existingTask.Metadata, map[string]any{
			"idempotencyKey":      idempotencyKey,
			"idempotentRequestAt": existingTask.UpdatedAt,
		})
		switch existingTask.Status {
		case ingestion.StatusSucceeded:
			existingTask.Metadata["idempotencyOutcome"] = "reused-completed-task"
		case ingestion.StatusRunning, ingestion.StatusPending:
			existingTask.Metadata["idempotencyOutcome"] = "reused-active-task"
		case ingestion.StatusFailed:
			existingTask.Metadata["idempotencyOutcome"] = "reused-failed-task-retry-required"
		default:
			existingTask.Metadata["idempotencyOutcome"] = "reused-existing-task"
		}
		if err := s.tasks.Upsert(ctx, existingTask); err != nil {
			return contracts.IngestionTaskStatusResponse{}, err
		}
		return toContractTaskStatus(existingTask), nil
	}

	taskID := fmt.Sprintf("ingest_%d", now.UnixMilli())
	maxAttempts := resolveMaxAttempts(request.Metadata, 3)
	requestMetadata := mergeMaps(cloneMap(request.Metadata), map[string]any{
		"idempotencyKey":     idempotencyKey,
		"requestIdentity":    requestIdentity,
		"idempotencyOutcome": "new-task-created",
		"executionSource":    "go-ingestion-service",
		"retryable":          false,
		"failureStage":       nil,
		"failureReason":      nil,
	})
	status := ingestion.TaskStatus{
		TaskID:          taskID,
		TraceID:         request.TraceID,
		KnowledgeBaseID: request.KnowledgeBaseID,
		DocumentID:      request.DocumentID,
		RequestedBy:     request.RequestedBy,
		Source:          toDomainSource(request.Source),
		Status:          ingestion.StatusPending,
		CurrentStage:    ingestion.StageQueued,
		AttemptCount:    0,
		MaxAttempts:     maxAttempts,
		Retryable:       false,
		NextRunAt:       now.Format(time.RFC3339),
		RetryAfterSec:   0,
		CreatedAt:       now.Format(time.RFC3339),
		UpdatedAt:       now.Format(time.RFC3339),
		ExecutionPlan:   toDomainExecutionPlan(request.ExecutionPlan),
		Metadata:        requestMetadata,
		Trace: []ingestion.TraceEvent{
			traceEvent(request.TraceID, taskID, "task-created", ingestion.StatusSucceeded, "ingestion task created in go execution plane", map[string]any{
				"knowledgeBaseId": request.KnowledgeBaseID,
				"documentId":      request.DocumentID,
				"idempotencyKey":  idempotencyKey,
			}),
			traceEvent(request.TraceID, taskID, ingestion.StageQueued, ingestion.StatusPending, "task queued for async ingestion worker", map[string]any{
				"parserType":      request.ExecutionPlan.Parser.ParserType,
				"chunking":        request.ExecutionPlan.Chunking.Strategy,
				"embedding":       request.ExecutionPlan.Embedding.Enabled,
				"indexing":        request.ExecutionPlan.Indexing.Enabled,
				"requestIdentity": requestIdentity,
				"maxAttempts":     maxAttempts,
			}),
		},
	}

	if err := s.tasks.Upsert(ctx, status); err != nil {
		return contracts.IngestionTaskStatusResponse{}, err
	}

	return toContractTaskStatus(status), nil
}

func (s *IngestionService) GetTask(ctx context.Context, taskID string) (contracts.IngestionTaskStatusResponse, error) {
	task, err := s.tasks.Get(ctx, taskID)
	if err != nil {
		return contracts.IngestionTaskStatusResponse{}, err
	}

	return toContractTaskStatus(task), nil
}

func toDomainSource(source contracts.IngestionSource) ingestion.Source {
	return ingestion.Source{
		SourceType: source.SourceType,
		URI:        source.URI,
		Filename:   source.Filename,
		MimeType:   source.MimeType,
		SizeBytes:  source.SizeBytes,
		Checksum:   source.Checksum,
	}
}

func toDomainExecutionPlan(plan contracts.IngestionExecutionPlan) ingestion.ExecutionPlan {
	return ingestion.ExecutionPlan{
		Parser: ingestion.ParserExecutionPlan{
			ParserType: plan.Parser.ParserType,
			Mode:       plan.Parser.Mode,
		},
		Chunking: ingestion.ChunkingExecutionPlan{
			Strategy:   plan.Chunking.Strategy,
			TargetSize: plan.Chunking.TargetSize,
			Overlap:    plan.Chunking.Overlap,
		},
		Embedding: ingestion.EmbeddingExecutionPlan{
			Enabled: plan.Embedding.Enabled,
			Model:   plan.Embedding.Model,
			Adapter: plan.Embedding.Adapter,
		},
		Indexing: ingestion.IndexingExecutionPlan{
			Enabled:   plan.Indexing.Enabled,
			IndexName: plan.Indexing.IndexName,
			StoreType: plan.Indexing.StoreType,
		},
	}
}

func toContractTaskStatus(task ingestion.TaskStatus) contracts.IngestionTaskStatusResponse {
	response := contracts.IngestionTaskStatusResponse{
		TaskID:          task.TaskID,
		TraceID:         task.TraceID,
		KnowledgeBaseID: task.KnowledgeBaseID,
		DocumentID:      task.DocumentID,
		RequestedBy:     task.RequestedBy,
		Source: contracts.IngestionSource{
			SourceType: task.Source.SourceType,
			URI:        task.Source.URI,
			Filename:   task.Source.Filename,
			MimeType:   task.Source.MimeType,
			SizeBytes:  task.Source.SizeBytes,
			Checksum:   task.Source.Checksum,
		},
		Status:        task.Status,
		CurrentStage:  task.CurrentStage,
		AttemptCount:  task.AttemptCount,
		MaxAttempts:   task.MaxAttempts,
		Retryable:     task.Retryable,
		NextRunAt:     task.NextRunAt,
		RetryAfterSec: task.RetryAfterSec,
		FailureReason: task.FailureReason,
		FailureStage:  task.FailureStage,
		CreatedAt:     task.CreatedAt,
		UpdatedAt:     task.UpdatedAt,
		StartedAt:     task.StartedAt,
		FinishedAt:    task.FinishedAt,
		ErrorMessage:  task.ErrorMessage,
		ExecutionPlan: contracts.IngestionExecutionPlan{
			Parser: contracts.ParserExecutionPlan{
				ParserType: task.ExecutionPlan.Parser.ParserType,
				Mode:       task.ExecutionPlan.Parser.Mode,
			},
			Chunking: contracts.ChunkingExecutionPlan{
				Strategy:   task.ExecutionPlan.Chunking.Strategy,
				TargetSize: task.ExecutionPlan.Chunking.TargetSize,
				Overlap:    task.ExecutionPlan.Chunking.Overlap,
			},
			Embedding: contracts.EmbeddingExecutionPlan{
				Enabled: task.ExecutionPlan.Embedding.Enabled,
				Model:   task.ExecutionPlan.Embedding.Model,
				Adapter: task.ExecutionPlan.Embedding.Adapter,
			},
			Indexing: contracts.IndexingExecutionPlan{
				Enabled:   task.ExecutionPlan.Indexing.Enabled,
				IndexName: task.ExecutionPlan.Indexing.IndexName,
				StoreType: task.ExecutionPlan.Indexing.StoreType,
			},
		},
		Chunks:   toContractChunks(task.Chunks),
		Trace:    toContractTrace(task.Trace),
		Metadata: cloneMap(task.Metadata),
	}

	if task.ParserResult != nil {
		response.ParserResult = &contracts.ParserResult{
			ParserBackend: task.ParserResult.ParserBackend,
			ParserName:    task.ParserResult.ParserName,
			ParserVersion: task.ParserResult.ParserVersion,
			Status:        task.ParserResult.Status,
			Warnings:      append([]string{}, task.ParserResult.Warnings...),
			Metrics: contracts.ParserMetrics{
				ParseDurationMs: task.ParserResult.Metrics.ParseDurationMs,
				ChunkDurationMs: task.ParserResult.Metrics.ChunkDurationMs,
			},
			ErrorMessage: task.ParserResult.ErrorMessage,
		}
		if task.ParserResult.ParsedDocument != nil {
			response.ParserResult.ParsedDocument = &contracts.ParsedDocument{
				DocumentID: task.ParserResult.ParsedDocument.DocumentID,
				Title:      task.ParserResult.ParsedDocument.Title,
				MimeType:   task.ParserResult.ParsedDocument.MimeType,
				Language:   task.ParserResult.ParsedDocument.Language,
				CharCount:  task.ParserResult.ParsedDocument.CharCount,
				PageCount:  task.ParserResult.ParsedDocument.PageCount,
				Metadata:   cloneMap(task.ParserResult.ParsedDocument.Metadata),
				Content: contracts.ParsedDocumentContent{
					Text:     task.ParserResult.ParsedDocument.Text,
					Sections: toContractSections(task.ParserResult.ParsedDocument.Sections),
				},
			}
		}
		response.ParserResult.Chunks = toContractChunks(task.Chunks)
	}
	if task.EmbeddingResult != nil {
		response.EmbeddingResult = &contracts.EmbeddingResult{
			Status:       task.EmbeddingResult.Status,
			Model:        task.EmbeddingResult.Model,
			Source:       task.EmbeddingResult.Source,
			VectorCount:  task.EmbeddingResult.VectorCount,
			Dimensions:   task.EmbeddingResult.Dimensions,
			Artifacts:    toContractEmbeddingArtifacts(task.EmbeddingResult.Artifacts),
			ErrorMessage: task.EmbeddingResult.ErrorMessage,
			Metadata:     cloneMap(task.EmbeddingResult.Metadata),
		}
	}
	if task.IndexWriteResult != nil {
		response.IndexWriteResult = &contracts.IndexWriteResult{
			Status:              task.IndexWriteResult.Status,
			IndexName:           task.IndexWriteResult.IndexName,
			StoreType:           task.IndexWriteResult.StoreType,
			Source:              task.IndexWriteResult.Source,
			Operation:           task.IndexWriteResult.Operation,
			RecordCount:         task.IndexWriteResult.RecordCount,
			IndexedChunkCount:   task.IndexWriteResult.IndexedChunkCount,
			SkippedRecordCount:  task.IndexWriteResult.SkippedRecordCount,
			ReplacedRecordCount: task.IndexWriteResult.ReplacedRecordCount,
			DeletedRecordCount:  task.IndexWriteResult.DeletedRecordCount,
			Records:             toContractIndexRecords(task.IndexWriteResult.Records),
			ErrorMessage:        task.IndexWriteResult.ErrorMessage,
			Metadata:            cloneMap(task.IndexWriteResult.Metadata),
		}
	}

	return response
}

func toContractEmbeddingArtifacts(artifacts []ingestion.EmbeddingArtifact) []contracts.EmbeddingArtifact {
	result := make([]contracts.EmbeddingArtifact, 0, len(artifacts))
	for _, artifact := range artifacts {
		result = append(result, contracts.EmbeddingArtifact{
			ChunkID:      artifact.ChunkID,
			Vector:       append([]float32{}, artifact.Vector...),
			Dimensions:   artifact.Dimensions,
			ContentHash:  artifact.ContentHash,
			EmbeddingRef: artifact.EmbeddingRef,
			Source:       artifact.Source,
			Metadata:     cloneMap(artifact.Metadata),
		})
	}
	return result
}

func toContractIndexRecords(records []ingestion.IndexRecord) []contracts.IndexRecord {
	result := make([]contracts.IndexRecord, 0, len(records))
	for _, record := range records {
		result = append(result, contracts.IndexRecord{
			RecordID:        record.RecordID,
			KnowledgeBaseID: record.KnowledgeBaseID,
			DocumentID:      record.DocumentID,
			ChunkID:         record.ChunkID,
			ChunkIndex:      record.ChunkIndex,
			Title:           record.Title,
			Content:         record.Content,
			EmbeddingRef:    record.EmbeddingRef,
			Vector:          append([]float32{}, record.Vector...),
			Source:          record.Source,
			Metadata:        cloneMap(record.Metadata),
		})
	}
	return result
}

func toContractSections(sections []ingestion.ParsedSection) []contracts.ParsedSection {
	result := make([]contracts.ParsedSection, 0, len(sections))
	for _, section := range sections {
		result = append(result, contracts.ParsedSection{
			SectionID: section.SectionID,
			Title:     section.Title,
			Level:     section.Level,
			Text:      section.Text,
		})
	}
	return result
}

func toContractChunks(chunks []ingestion.Chunk) []contracts.ParsedChunk {
	result := make([]contracts.ParsedChunk, 0, len(chunks))
	for _, chunk := range chunks {
		result = append(result, contracts.ParsedChunk{
			ChunkID:    chunk.ChunkID,
			DocumentID: chunk.DocumentID,
			ChunkIndex: chunk.ChunkIndex,
			Text:       chunk.Text,
			CharCount:  chunk.CharCount,
			TokenCount: chunk.TokenCount,
			Metadata: contracts.ParsedChunkMetadata{
				SectionPath: append([]string{}, chunk.Metadata.SectionPath...),
				StartOffset: chunk.Metadata.StartOffset,
				EndOffset:   chunk.Metadata.EndOffset,
				PageNumber:  chunk.Metadata.PageNumber,
			},
		})
	}
	return result
}

func toContractTrace(events []ingestion.TraceEvent) []contracts.ProcessingTraceEvent {
	result := make([]contracts.ProcessingTraceEvent, 0, len(events))
	for _, event := range events {
		result = append(result, contracts.ProcessingTraceEvent{
			TraceID:   event.TraceID,
			TaskID:    event.TaskID,
			Stage:     event.Stage,
			Level:     event.Level,
			Status:    event.Status,
			Message:   event.Message,
			Timestamp: event.Timestamp,
			Metadata:  cloneMap(event.Metadata),
		})
	}
	return result
}

func traceEvent(traceID, taskID, stage, status, message string, metadata map[string]any) ingestion.TraceEvent {
	level := "info"
	if status == ingestion.StatusFailed {
		level = "error"
	}
	return ingestion.TraceEvent{
		TraceID:   traceID,
		TaskID:    taskID,
		Stage:     stage,
		Level:     level,
		Status:    status,
		Message:   message,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Metadata:  cloneMap(metadata),
	}
}

func mergeMaps(base map[string]any, extra map[string]any) map[string]any {
	merged := cloneMap(base)
	for key, value := range extra {
		merged[key] = value
	}
	return merged
}

func computeRequestIdentity(request contracts.IngestionTaskCreateRequest) string {
	if checksum := strings.TrimSpace(request.Source.Checksum); checksum != "" {
		return "checksum:" + checksum
	}
	sum := sha256.Sum256([]byte(strings.Join([]string{
		request.Source.SourceType,
		request.Source.URI,
		request.Source.Filename,
		request.Source.MimeType,
		fmt.Sprintf("%d", request.Source.SizeBytes),
	}, "|")))
	return "source:" + hex.EncodeToString(sum[:])
}

func resolveMaxAttempts(metadata map[string]any, fallback int) int {
	if fallback <= 0 {
		fallback = 3
	}
	if metadata == nil {
		return fallback
	}
	value, ok := metadata["maxAttempts"]
	if !ok {
		return fallback
	}
	switch typed := value.(type) {
	case float64:
		if int(typed) > 0 {
			return int(typed)
		}
	case int:
		if typed > 0 {
			return typed
		}
	case int32:
		if typed > 0 {
			return int(typed)
		}
	case int64:
		if typed > 0 {
			return int(typed)
		}
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		if err == nil && parsed > 0 {
			return parsed
		}
	}
	return fallback
}

func computeIdempotencyKey(knowledgeBaseID string, documentID string, requestIdentity string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{
		strings.TrimSpace(knowledgeBaseID),
		strings.TrimSpace(documentID),
		strings.TrimSpace(requestIdentity),
	}, "|")))
	return hex.EncodeToString(sum[:])
}
