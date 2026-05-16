package http

import (
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	rateLimitPerSec = 10
	rateLimitBurst  = 20
	rateLimitTTL    = 5 * time.Minute
)

type tokenBucket struct {
	mu       sync.Mutex
	tokens   float64
	lastFill time.Time
}

func RateLimitMiddleware(next http.Handler) http.Handler {
	buckets := &sync.Map{}

	// Background cleanup of stale buckets
	go func() {
		for {
			time.Sleep(rateLimitTTL)
			now := time.Now()
			buckets.Range(func(key, value any) bool {
				bucket := value.(*tokenBucket)
				if now.Sub(bucket.lastFill) > rateLimitTTL {
					buckets.Delete(key)
				}
				return true
			})
		}
	}()

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/internal/") {
			next.ServeHTTP(w, r)
			return
		}

		ip := clientIP(r)
		bucketI, _ := buckets.LoadOrStore(ip, &tokenBucket{
			tokens:   rateLimitBurst,
			lastFill: time.Now(),
		})
		bucket := bucketI.(*tokenBucket)

		bucket.mu.Lock()
		now := time.Now()
		elapsed := now.Sub(bucket.lastFill).Seconds()
		bucket.tokens = min(float64(rateLimitBurst), bucket.tokens+elapsed*float64(rateLimitPerSec))
		bucket.lastFill = now

		allow := bucket.tokens >= 1
		if allow {
			bucket.tokens--
		}
		bucket.mu.Unlock()

		if !allow {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			json.NewEncoder(w).Encode(map[string]any{
				"error":          "rate_limit_exceeded",
				"retry_after_ms": 1000,
			})
			return
		}

		next.ServeHTTP(w, r)
	})
}

func clientIP(r *http.Request) string {
	if fwd := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); fwd != "" {
		parts := strings.Split(fwd, ",")
		return strings.TrimSpace(parts[len(parts)-1])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
