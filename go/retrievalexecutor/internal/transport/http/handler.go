package http

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	ingestionstore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestionstore"
	indexedsource "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/retrieval/indexedsource"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/application/scheduler"
	application "github.com/nageoffer/ragent/go/retrievalexecutor/internal/application/service"
	"github.com/nageoffer/ragent/go/retrievalexecutor/pkg/contracts"
)

type HealthCheck func(ctx context.Context) error

type HealthRegistry struct {
	checks map[string]HealthCheck
}

func NewHealthRegistry() *HealthRegistry {
	return &HealthRegistry{checks: map[string]HealthCheck{}}
}

func (r *HealthRegistry) Register(name string, check HealthCheck) {
	r.checks[name] = check
}

func (r *HealthRegistry) RunAll(ctx context.Context, timeout time.Duration) map[string]string {
	results := map[string]string{}
	for name, check := range r.checks {
		checkCtx, cancel := context.WithTimeout(ctx, timeout)
		if err := check(checkCtx); err != nil {
			results[name] = fmt.Sprintf("unhealthy: %v", err)
		} else {
			results[name] = "ok"
		}
		cancel()
	}
	return results
}

const maxRequestBodySize = 1 << 20 // 1MB

type Handler struct {
	retrievalService *application.RetrievalService
	ingestionService *application.IngestionService
	ingestionRunner  *scheduler.IngestionRunner
	health           *HealthRegistry
}

func NewHandler(retrievalService *application.RetrievalService, ingestionService *application.IngestionService, ingestionRunner *scheduler.IngestionRunner, health *HealthRegistry) *Handler {
	return &Handler{
		retrievalService: retrievalService,
		ingestionService: ingestionService,
		ingestionRunner:  ingestionRunner,
		health:           health,
	}
}

func NewHandlerWithDefaults(retrievalService *application.RetrievalService, ingestionService *application.IngestionService, ingestionRunner *scheduler.IngestionRunner) *Handler {
	return NewHandler(retrievalService, ingestionService, ingestionRunner, NewHealthRegistry())
}

func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", h.handleHealth)
	mux.HandleFunc("/healthz", h.handleHealth)
	mux.HandleFunc("/internal/retrieval/search", h.handleSearch)
	mux.HandleFunc("/internal/ingestion/tasks", h.handleIngestionTasks)
	mux.HandleFunc("/internal/ingestion/tasks/", h.handleIngestionTaskByID)
	mux.HandleFunc("/internal/ingestion/worker/run", h.handleIngestionWorkerRun)
	mux.HandleFunc("/internal/metrics", h.handleMetrics)
	return mux
}

func (h *Handler) handleHealth(writer http.ResponseWriter, request *http.Request) {
	status := http.StatusOK
	results := map[string]string{}
	if h.health != nil && len(h.health.checks) > 0 {
		results = h.health.RunAll(request.Context(), 3*time.Second)
		for _, v := range results {
			if v != "ok" {
				status = http.StatusServiceUnavailable
				break
			}
		}
	} else {
		results["server"] = "ok"
	}
	writeJSON(writer, status, map[string]any{
		"status":   statusText(status),
		"checks":   results,
	})
}

func statusText(status int) string {
	if status == http.StatusOK {
		return "ok"
	}
	return "unhealthy"
}

func (h *Handler) handleSearch(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writer.Header().Set("Allow", http.MethodPost)
		writeJSON(writer, http.StatusMethodNotAllowed, contracts.APIError{
			Code:    "METHOD_NOT_ALLOWED",
			Message: "method not allowed",
		})
		return
	}

	defer request.Body.Close()

	var payload contracts.RetrievalSearchRequest
	if err := json.NewDecoder(io.LimitReader(request.Body, maxRequestBodySize)).Decode(&payload); err != nil {
		writeJSON(writer, http.StatusBadRequest, contracts.APIError{
			Code:    "BAD_REQUEST",
			Message: "request body must be valid JSON",
		})
		return
	}

	response, err := h.retrievalService.Search(request.Context(), payload)
	if err != nil {
		status := http.StatusInternalServerError
		apiError := contracts.APIError{
			Code:    "RETRIEVAL_EXECUTION_FAILED",
			Message: "retrieval execution failed",
			TraceID: payload.TraceID,
		}
		if errors.Is(err, context.DeadlineExceeded) {
			status = http.StatusGatewayTimeout
			apiError.Code = "UPSTREAM_TIMEOUT"
			apiError.Message = "upstream service timed out"
		} else if errors.Is(err, application.ErrInvalidRequest) {
			status = http.StatusBadRequest
			apiError.Code = "INVALID_RETRIEVAL_REQUEST"
			apiError.Message = "traceId and query are required"
		}
		writeJSON(writer, status, apiError)
		return
	}

	writeJSON(writer, http.StatusOK, response)
}

func (h *Handler) handleIngestionTasks(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writer.Header().Set("Allow", http.MethodPost)
		writeJSON(writer, http.StatusMethodNotAllowed, contracts.APIError{
			Code:    "METHOD_NOT_ALLOWED",
			Message: "method not allowed",
		})
		return
	}

	defer request.Body.Close()

	var payload contracts.IngestionTaskCreateRequest
	if err := json.NewDecoder(io.LimitReader(request.Body, maxRequestBodySize)).Decode(&payload); err != nil {
		writeJSON(writer, http.StatusBadRequest, contracts.APIError{
			Code:    "BAD_REQUEST",
			Message: "request body must be valid JSON",
		})
		return
	}

	response, err := h.ingestionService.CreateTask(request.Context(), payload)
	if err != nil {
		status := http.StatusInternalServerError
		apiError := contracts.APIError{
			Code:    "INGESTION_EXECUTION_FAILED",
			Message: "ingestion execution failed",
			TraceID: payload.TraceID,
		}
		if errors.Is(err, context.DeadlineExceeded) {
			status = http.StatusGatewayTimeout
			apiError.Code = "UPSTREAM_TIMEOUT"
			apiError.Message = "upstream service timed out"
		} else if errors.Is(err, application.ErrInvalidIngestionRequest) {
			status = http.StatusBadRequest
			apiError.Code = "INVALID_INGESTION_REQUEST"
			apiError.Message = "traceId, knowledgeBaseId, documentId, source.filename, and source.uri are required"
		}
		writeJSON(writer, status, apiError)
		return
	}

	writeJSON(writer, http.StatusOK, response)
}

func (h *Handler) handleIngestionTaskByID(writer http.ResponseWriter, request *http.Request) {
	trimmed := strings.TrimPrefix(request.URL.Path, "/internal/ingestion/tasks/")
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) == 0 || strings.TrimSpace(parts[0]) == "" {
		writeJSON(writer, http.StatusBadRequest, contracts.APIError{
			Code:    "INVALID_INGESTION_REQUEST",
			Message: "task id is required",
		})
		return
	}
	taskID := parts[0]

	if len(parts) == 1 && request.Method == http.MethodGet {
		response, err := h.ingestionService.GetTask(request.Context(), taskID)
		if err != nil {
			status := http.StatusInternalServerError
			apiError := contracts.APIError{
				Code:    "INGESTION_TASK_LOOKUP_FAILED",
				Message: "ingestion task lookup failed",
			}
			if errors.Is(err, context.DeadlineExceeded) {
				status = http.StatusGatewayTimeout
				apiError.Code = "UPSTREAM_TIMEOUT"
				apiError.Message = "upstream service timed out"
			} else if errors.Is(err, ingestionstore.ErrTaskNotFound) {
				status = http.StatusNotFound
				apiError.Code = "INGESTION_TASK_NOT_FOUND"
				apiError.Message = "ingestion task not found"
			}
			writeJSON(writer, status, apiError)
			return
		}

		writeJSON(writer, http.StatusOK, response)
		return
	}

	if len(parts) == 2 && parts[1] == "run" && request.Method == http.MethodPost {
		if h.ingestionRunner == nil {
			writeJSON(writer, http.StatusServiceUnavailable, contracts.APIError{
				Code:    "INGESTION_RUNNER_UNAVAILABLE",
				Message: "ingestion runner is unavailable",
			})
			return
		}
		task, err := h.ingestionRunner.RunTask(request.Context(), taskID)
		if err != nil {
			status := http.StatusInternalServerError
			apiError := contracts.APIError{
				Code:    "INGESTION_TASK_RUN_FAILED",
				Message: "ingestion task run failed",
			}
			if errors.Is(err, context.DeadlineExceeded) {
				status = http.StatusGatewayTimeout
				apiError.Code = "UPSTREAM_TIMEOUT"
				apiError.Message = "upstream service timed out"
			} else if errors.Is(err, ingestionstore.ErrTaskNotFound) {
				status = http.StatusNotFound
				apiError.Code = "INGESTION_TASK_NOT_FOUND"
				apiError.Message = "ingestion task not found"
			} else if errors.Is(err, ingestionstore.ErrTaskNotClaimable) {
				status = http.StatusConflict
				apiError.Code = "INGESTION_TASK_NOT_RUNNABLE"
				apiError.Message = "ingestion task is not runnable"
			}
			writeJSON(writer, status, apiError)
			return
		}

		response, lookupErr := h.ingestionService.GetTask(request.Context(), task.TaskID)
		if lookupErr != nil {
			writeJSON(writer, http.StatusInternalServerError, contracts.APIError{
				Code:    "INGESTION_TASK_LOOKUP_FAILED",
				Message: "ingestion task lookup failed after run",
			})
			return
		}
		writeJSON(writer, http.StatusOK, response)
		return
	}

	writer.Header().Set("Allow", strings.Join([]string{http.MethodGet, http.MethodPost}, ", "))
	writeJSON(writer, http.StatusMethodNotAllowed, contracts.APIError{
		Code:    "METHOD_NOT_ALLOWED",
		Message: "method not allowed",
	})
}

func (h *Handler) handleIngestionWorkerRun(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writer.Header().Set("Allow", http.MethodPost)
		writeJSON(writer, http.StatusMethodNotAllowed, contracts.APIError{
			Code:    "METHOD_NOT_ALLOWED",
			Message: "method not allowed",
		})
		return
	}
	if h.ingestionRunner == nil {
		writeJSON(writer, http.StatusServiceUnavailable, contracts.APIError{
			Code:    "INGESTION_RUNNER_UNAVAILABLE",
			Message: "ingestion runner is unavailable",
		})
		return
	}

	limit := 0
	if rawLimit := strings.TrimSpace(request.URL.Query().Get("limit")); rawLimit != "" {
		parsed, err := strconv.Atoi(rawLimit)
		if err == nil && parsed > 0 {
			limit = parsed
		}
	}

	summary, err := h.ingestionRunner.RunOnce(request.Context(), limit)
	if err != nil {
		status := http.StatusInternalServerError
		apiError := contracts.APIError{
			Code:    "INGESTION_WORKER_RUN_FAILED",
			Message: "ingestion worker run failed",
		}
		if errors.Is(err, context.DeadlineExceeded) {
			status = http.StatusGatewayTimeout
			apiError.Code = "UPSTREAM_TIMEOUT"
			apiError.Message = "upstream service timed out"
		}
		writeJSON(writer, status, apiError)
		return
	}
	writeJSON(writer, http.StatusOK, summary)
}

func (h *Handler) handleMetrics(writer http.ResponseWriter, request *http.Request) {
	stats := indexedsource.BM25CacheStats()
	hitRate := 0.0
	if total := stats.Hits + stats.Misses; total > 0 {
		hitRate = float64(stats.Hits) / float64(total) * 100
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"bm25Cache": map[string]any{
			"hits":      stats.Hits,
			"misses":    stats.Misses,
			"hitRate":   fmt.Sprintf("%.1f%%", hitRate),
			"entries":   stats.Entries,
			"maxSize":   stats.MaxSize,
			"evictions": stats.Evictions,
		},
	})
}

func writeJSON(writer http.ResponseWriter, status int, payload any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(payload)
}
