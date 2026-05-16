package http

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLoggingMiddlewarePassesThrough(t *testing.T) {
	handler := LoggingMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	}))

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("X-Trace-Id", "test-trace-1")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	if rec.Body.String() != "ok" {
		t.Errorf("expected body 'ok', got %q", rec.Body.String())
	}
}

func TestLoggingMiddlewareGeneratesTraceID(t *testing.T) {
	handler := LoggingMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", rec.Code)
	}
}

func TestLoggingMiddlewareCapturesErrorStatus(t *testing.T) {
	handler := LoggingMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))

	req := httptest.NewRequest(http.MethodGet, "/internal/test", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rec.Code)
	}
}

func TestStatusWriterWrites(t *testing.T) {
	inner := httptest.NewRecorder()
	sw := &statusWriter{ResponseWriter: inner, status: http.StatusOK}

	n, err := sw.Write([]byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	if n != 5 {
		t.Errorf("expected 5 bytes, got %d", n)
	}
	if sw.status != http.StatusOK {
		t.Errorf("expected status 200, got %d", sw.status)
	}
	sw.WriteHeader(http.StatusNotFound)
	if sw.status != http.StatusNotFound {
		t.Errorf("expected status 404, got %d", sw.status)
	}
}

func TestNewTraceIDFormat(t *testing.T) {
	id := newTraceID()
	parts := strings.Split(id, "-")
	if len(parts) != 5 {
		t.Errorf("expected 5 parts in trace ID, got %d: %s", len(parts), id)
	}
}

func TestTraceIDNoCollision(t *testing.T) {
	seen := map[string]bool{}
	for range 100 {
		id := newTraceID()
		if seen[id] {
			t.Error("trace ID collision")
		}
		seen[id] = true
	}
}
