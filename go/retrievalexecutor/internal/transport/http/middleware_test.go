package http

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestAuthMiddlewareNoTokenSet(t *testing.T) {
	os.Unsetenv("INTERNAL_API_TOKEN")

	handler := AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/internal/retrieval/search", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 when no token configured, got %d", rec.Code)
	}
}

func TestAuthMiddlewareValidToken(t *testing.T) {
	os.Setenv("INTERNAL_API_TOKEN", "secret123")
	defer os.Unsetenv("INTERNAL_API_TOKEN")

	handler := AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/internal/retrieval/search", nil)
	req.Header.Set("X-Internal-Token", "secret123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestAuthMiddlewareInvalidToken(t *testing.T) {
	os.Setenv("INTERNAL_API_TOKEN", "secret123")
	defer os.Unsetenv("INTERNAL_API_TOKEN")

	handler := AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/internal/ingestion/tasks", nil)
	req.Header.Set("X-Internal-Token", "wrong")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestAuthMiddlewareMissingToken(t *testing.T) {
	os.Setenv("INTERNAL_API_TOKEN", "secret123")
	defer os.Unsetenv("INTERNAL_API_TOKEN")

	handler := AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/internal/retrieval/search", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestAuthMiddlewareSkipsHealth(t *testing.T) {
	os.Setenv("INTERNAL_API_TOKEN", "secret123")
	defer os.Unsetenv("INTERNAL_API_TOKEN")

	handler := AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 for /health, got %d", rec.Code)
	}
}

func TestHealthEndpoint(t *testing.T) {
	handler := NewHandlerWithDefaults(nil, nil, nil)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handler.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}
