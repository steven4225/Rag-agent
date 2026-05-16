package http

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
)

func AuthMiddleware(next http.Handler) http.Handler {
	token := strings.TrimSpace(os.Getenv("INTERNAL_API_TOKEN"))
	if token == "" {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/internal/") {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(map[string]string{
					"code":    "AUTH_NOT_CONFIGURED",
					"message": "INTERNAL_API_TOKEN is not configured",
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/internal/") {
			next.ServeHTTP(w, r)
			return
		}
		if strings.TrimSpace(r.Header.Get("X-Internal-Token")) != token {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]string{
				"code":    "UNAUTHORIZED",
				"message": "missing or invalid internal token",
			})
			return
		}
		next.ServeHTTP(w, r)
	})
}
