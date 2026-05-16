package http

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestRateLimitAllowsNormalTraffic(t *testing.T) {
	handler := RateLimitMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodGet, "/internal/retrieval/search", nil)
		req.RemoteAddr = "10.0.0.1:1234"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("request %d: expected 200, got %d", i, rec.Code)
		}
	}
}

func TestRateLimitBlocksExcess(t *testing.T) {
	handler := RateLimitMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// Exhaust the burst
	for i := 0; i < rateLimitBurst+5; i++ {
		req := httptest.NewRequest(http.MethodGet, "/internal/retrieval/search", nil)
		req.RemoteAddr = "10.0.0.2:5678"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
	}

	// Should be rate limited now
	req := httptest.NewRequest(http.MethodGet, "/internal/retrieval/search", nil)
	req.RemoteAddr = "10.0.0.2:5678"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429, got %d", rec.Code)
	}

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "rate_limit_exceeded" {
		t.Errorf("expected rate_limit_exceeded, got %v", body["error"])
	}
	if body["retry_after_ms"] != float64(1000) {
		t.Errorf("expected retry_after_ms=1000, got %v", body["retry_after_ms"])
	}
}

func TestRateLimitSeparatePerIP(t *testing.T) {
	handler := RateLimitMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// Exhaust IP1
	for i := 0; i < rateLimitBurst+5; i++ {
		req := httptest.NewRequest(http.MethodGet, "/internal/test", nil)
		req.RemoteAddr = "10.0.0.3:1111"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
	}

	// IP2 should still work
	req := httptest.NewRequest(http.MethodGet, "/internal/test", nil)
	req.RemoteAddr = "10.0.0.4:2222"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("IP2: expected 200, got %d", rec.Code)
	}

	// IP1 should be blocked
	req = httptest.NewRequest(http.MethodGet, "/internal/test", nil)
	req.RemoteAddr = "10.0.0.3:1111"
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("IP1: expected 429, got %d", rec.Code)
	}
}

func TestRateLimitSkipsNonInternal(t *testing.T) {
	handler := RateLimitMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// /health should not be rate limited
	for i := 0; i < rateLimitBurst+50; i++ {
		req := httptest.NewRequest(http.MethodGet, "/health", nil)
		req.RemoteAddr = "10.0.0.5:3333"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("request %d: expected 200, got %d", i, rec.Code)
		}
	}
}

func TestClientIPForwardedFor(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Forwarded-For", "192.168.1.1, 10.0.0.99")
	req.RemoteAddr = "127.0.0.1:9999"

	ip := clientIP(req)
	if ip != "10.0.0.99" {
		t.Errorf("expected last forwarded IP, got %s", ip)
	}
}

func TestClientIPRemoteAddr(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.88:12345"

	ip := clientIP(req)
	if ip != "10.0.0.88" {
		t.Errorf("expected 10.0.0.88, got %s", ip)
	}
}

func TestTokenBucketConcurrent(t *testing.T) {
	var wg sync.WaitGroup

	for range 5 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 3 {
				bucket := &tokenBucket{tokens: rateLimitBurst, lastFill: time.Now()}
				_ = bucket.tokens
			}
		}()
	}
	wg.Wait()
}
