package http

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	textchunker "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/chunker/textchunker"
	deterministicembedding "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/embedding/deterministic"
	jsonindexstore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexstore/jsonstore"
	ingestionmemory "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestion-memory"
	localcorpus "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/local-corpus"
	textparser "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/parser/textparser"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/application/scheduler"
	application "github.com/nageoffer/ragent/go/retrievalexecutor/internal/application/service"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/application/worker"
	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/retrieval"
)

func TestHandleSearch(t *testing.T) {
	retrievalService := application.NewRetrievalService(localcorpus.NewExecutor(localcorpus.DefaultCorpus()))
	ingestionService := application.NewIngestionService(
		textparser.NewAdapter(),
		textchunker.NewChunker(),
		deterministicembedding.NewAdapter(),
		jsonindexstore.NewStore(filepath.Join(t.TempDir(), "index.json")),
		ingestionmemory.NewRepository(),
	)
	handler := NewHandlerWithDefaults(retrievalService, ingestionService, nil)

	body := bytes.NewBufferString(`{"traceId":"trace-456","query":"release rollout guidance","knowledgeBaseIds":["kb_product"],"topK":1}`)
	request := httptest.NewRequest(http.MethodPost, "/internal/retrieval/search", body)
	recorder := httptest.NewRecorder()

	handler.Routes().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", recorder.Code)
	}

	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("expected valid json response, got %v", err)
	}

	if payload["traceId"] != "trace-456" {
		t.Fatalf("expected traceId in response, got %#v", payload["traceId"])
	}
	if payload["source"] != retrieval.SourceLocalCorpus {
		t.Fatalf("expected %s source, got %#v", retrieval.SourceLocalCorpus, payload["source"])
	}
}

func TestHandleIngestionTaskCreateAndGet(t *testing.T) {
	retrievalService := application.NewRetrievalService(localcorpus.NewExecutor(localcorpus.DefaultCorpus()))
	taskRepo := ingestionmemory.NewRepository()
	indexStore := jsonindexstore.NewStore(filepath.Join(t.TempDir(), "index.json"))
	ingestionService := application.NewIngestionService(
		textparser.NewAdapter(),
		textchunker.NewChunker(),
		deterministicembedding.NewAdapter(),
		indexStore,
		taskRepo,
	)
	ingestionWorker := worker.NewIngestionWorker(
		textparser.NewAdapter(),
		textchunker.NewChunker(),
		deterministicembedding.NewAdapter(),
		indexStore,
		taskRepo,
	)
	ingestionRunner := scheduler.NewIngestionRunner(
		taskRepo,
		ingestionWorker,
		"test-worker",
		5*time.Second,
		30*time.Second,
		2,
	)
	handler := NewHandlerWithDefaults(retrievalService, ingestionService, ingestionRunner)
	content := "# Policy Handbook\n\nParagraph one for ingestion.\n\n## Runbook\n\nParagraph two keeps the chunker honest."
	body := fmt.Sprintf(`{
	  "traceId":"trace-ingest-1",
	  "knowledgeBaseId":"kb_policy",
	  "documentId":"doc_1",
	  "requestedBy":"admin_demo",
	  "source":{
	    "sourceType":"upload",
	    "uri":"data:text/markdown;base64,%s",
	    "filename":"policy.md",
	    "mimeType":"text/markdown",
	    "sizeBytes":%d
	  },
	  "executionPlan":{
	    "parser":{"parserType":"text-parser","mode":"adapter"},
	    "chunking":{"strategy":"paragraph","targetSize":1200,"overlap":120},
	    "embedding":{"enabled":true,"model":"mock-embedding-v1","adapter":"deterministic"},
	    "indexing":{"enabled":true,"indexName":"kb_policy","storeType":"json-file"}
	  },
	  "metadata":{"initiatedFrom":"test"}
	}`, base64.StdEncoding.EncodeToString([]byte(content)), len(content))

	createBody := bytes.NewBufferString(body)
	createRequest := httptest.NewRequest(http.MethodPost, "/internal/ingestion/tasks", createBody)
	createRecorder := httptest.NewRecorder()

	handler.Routes().ServeHTTP(createRecorder, createRequest)

	if createRecorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", createRecorder.Code)
	}

	var created map[string]any
	if err := json.Unmarshal(createRecorder.Body.Bytes(), &created); err != nil {
		t.Fatalf("expected valid json response, got %v", err)
	}

	taskID, ok := created["taskId"].(string)
	if !ok || taskID == "" {
		t.Fatalf("expected taskId in response, got %#v", created["taskId"])
	}

	getRequest := httptest.NewRequest(http.MethodGet, "/internal/ingestion/tasks/"+taskID, nil)
	getRecorder := httptest.NewRecorder()
	handler.Routes().ServeHTTP(getRecorder, getRequest)

	if getRecorder.Code != http.StatusOK {
		t.Fatalf("expected 200 on task get, got %d", getRecorder.Code)
	}

	var fetched map[string]any
	if err := json.Unmarshal(getRecorder.Body.Bytes(), &fetched); err != nil {
		t.Fatalf("expected valid json response, got %v", err)
	}

	if fetched["traceId"] != "trace-ingest-1" {
		t.Fatalf("expected trace id to round trip, got %#v", fetched["traceId"])
	}
	if fetched["currentStage"] != "queued" {
		t.Fatalf("expected queued stage before run, got %#v", fetched["currentStage"])
	}

	runRequest := httptest.NewRequest(http.MethodPost, "/internal/ingestion/tasks/"+taskID+"/run", nil)
	runRecorder := httptest.NewRecorder()
	handler.Routes().ServeHTTP(runRecorder, runRequest)

	if runRecorder.Code != http.StatusOK {
		t.Fatalf("expected 200 on task run, got %d", runRecorder.Code)
	}

	getAfterRunRequest := httptest.NewRequest(http.MethodGet, "/internal/ingestion/tasks/"+taskID, nil)
	getAfterRunRecorder := httptest.NewRecorder()
	handler.Routes().ServeHTTP(getAfterRunRecorder, getAfterRunRequest)
	if getAfterRunRecorder.Code != http.StatusOK {
		t.Fatalf("expected 200 on task get after run, got %d", getAfterRunRecorder.Code)
	}
	fetched = map[string]any{}
	if err := json.Unmarshal(getAfterRunRecorder.Body.Bytes(), &fetched); err != nil {
		t.Fatalf("expected valid json response after run, got %v", err)
	}
	if fetched["currentStage"] != "completed" {
		t.Fatalf("expected completed stage after run, got %#v", fetched["currentStage"])
	}
	parserResult, ok := fetched["parserResult"].(map[string]any)
	if !ok || parserResult["parserName"] != "go-text-parser" {
		t.Fatalf("expected real parser result, got %#v", fetched["parserResult"])
	}
	chunks, ok := fetched["chunks"].([]any)
	if !ok || len(chunks) == 0 {
		t.Fatalf("expected chunk payloads in response, got %#v", fetched["chunks"])
	}
	if fetched["embeddingResult"] == nil {
		t.Fatalf("expected embedding result in response")
	}
	if fetched["indexWriteResult"] == nil {
		t.Fatalf("expected index write result in response")
	}
}

func TestHandleIngestionWorkerRun(t *testing.T) {
	retrievalService := application.NewRetrievalService(localcorpus.NewExecutor(localcorpus.DefaultCorpus()))
	taskRepo := ingestionmemory.NewRepository()
	indexStore := jsonindexstore.NewStore(filepath.Join(t.TempDir(), "index.json"))
	ingestionService := application.NewIngestionService(
		textparser.NewAdapter(),
		textchunker.NewChunker(),
		deterministicembedding.NewAdapter(),
		indexStore,
		taskRepo,
	)
	ingestionWorker := worker.NewIngestionWorker(
		textparser.NewAdapter(),
		textchunker.NewChunker(),
		deterministicembedding.NewAdapter(),
		indexStore,
		taskRepo,
	)
	ingestionRunner := scheduler.NewIngestionRunner(taskRepo, ingestionWorker, "test-worker", 5*time.Second, 30*time.Second, 2)
	handler := NewHandlerWithDefaults(retrievalService, ingestionService, ingestionRunner)

	createBody := bytes.NewBufferString(buildTaskCreateRequestJSON("trace-worker-run", "doc_worker_run"))
	createRequest := httptest.NewRequest(http.MethodPost, "/internal/ingestion/tasks", createBody)
	createRecorder := httptest.NewRecorder()
	handler.Routes().ServeHTTP(createRecorder, createRequest)
	if createRecorder.Code != http.StatusOK {
		t.Fatalf("expected 200 on create before worker run, got %d", createRecorder.Code)
	}

	runRequest := httptest.NewRequest(http.MethodPost, "/internal/ingestion/worker/run?limit=1", nil)
	runRecorder := httptest.NewRecorder()
	handler.Routes().ServeHTTP(runRecorder, runRequest)
	if runRecorder.Code != http.StatusOK {
		t.Fatalf("expected 200 on worker run, got %d", runRecorder.Code)
	}

	var summary map[string]any
	if err := json.Unmarshal(runRecorder.Body.Bytes(), &summary); err != nil {
		t.Fatalf("expected valid worker run summary, got %v", err)
	}
	if claimed, _ := summary["claimed"].(float64); claimed < 1 {
		t.Fatalf("expected claimed >= 1, got %#v", summary["claimed"])
	}
}

func buildTaskCreateRequestJSON(traceID string, documentID string) string {
	content := "# Worker Run\n\nRun worker manually."
	return fmt.Sprintf(`{
	  "traceId":"%s",
	  "knowledgeBaseId":"kb_policy",
	  "documentId":"%s",
	  "requestedBy":"admin_demo",
	  "source":{
	    "sourceType":"upload",
	    "uri":"data:text/markdown;base64,%s",
	    "filename":"worker.md",
	    "mimeType":"text/markdown",
	    "sizeBytes":%d
	  },
	  "executionPlan":{
	    "parser":{"parserType":"text-parser","mode":"adapter"},
	    "chunking":{"strategy":"paragraph","targetSize":1200,"overlap":120},
	    "embedding":{"enabled":true,"model":"mock-embedding-v1","adapter":"deterministic"},
	    "indexing":{"enabled":true,"indexName":"kb_policy","storeType":"json-file"}
	  }
	}`, traceID, documentID, base64.StdEncoding.EncodeToString([]byte(content)), len(content))
}
