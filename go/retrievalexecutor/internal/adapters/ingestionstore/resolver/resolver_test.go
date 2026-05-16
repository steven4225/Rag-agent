package resolver

import (
	"os"
	"path/filepath"
	"testing"

	jsonstore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestionstore/jsonstore"
	sqlitestore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestionstore/sqlitestore"
)

func TestResolveFromEnv_DefaultsToJSONStore(t *testing.T) {
	t.Setenv("GO_INGESTION_TASK_STORE_BACKEND", "")
	t.Setenv("GO_INGESTION_TASK_STORE_PATH", filepath.Join(t.TempDir(), "task-store.json"))

	repo, err := ResolveFromEnv()
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if _, ok := repo.(*jsonstore.Store); !ok {
		t.Fatalf("expected *jsonstore.Store, got %T", repo)
	}
}

func TestResolveFromEnv_RejectsUnknownBackend(t *testing.T) {
	t.Setenv("GO_INGESTION_TASK_STORE_BACKEND", "memory")
	t.Setenv("GO_INGESTION_TASK_STORE_PATH", filepath.Join(t.TempDir(), "task-store.json"))

	_, err := ResolveFromEnv()
	if err == nil {
		t.Fatal("expected error for unsupported backend")
	}
}

func TestResolve_RejectsUnknownBackend(t *testing.T) {
	_, err := Resolve(Config{
		Backend: "memory",
	})
	if err == nil {
		t.Fatal("expected error for unsupported backend")
	}
}

func TestResolveFromEnv_SQLiteStore(t *testing.T) {
	t.Setenv("GO_INGESTION_TASK_STORE_BACKEND", "sqlite")
	t.Setenv("GO_INGESTION_TASK_STORE_SQLITE_PATH", filepath.Join(t.TempDir(), "task-store.db"))
	t.Setenv("GO_INGESTION_TASK_STORE_BOOTSTRAP_JSON_PATH", "")

	repo, err := ResolveFromEnv()
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	sqliteRepo, ok := repo.(*sqlitestore.Store)
	if !ok {
		t.Fatalf("expected *sqlitestore.Store, got %T", repo)
	}
	t.Cleanup(func() {
		_ = sqliteRepo.Close()
	})
}

func TestResolveFromEnv_SQLiteFallsBackToJSON(t *testing.T) {
	malformed := filepath.Join(t.TempDir(), "broken.json")
	if err := os.WriteFile(malformed, []byte("{"), 0o644); err != nil {
		t.Fatalf("expected malformed json fixture write success, got %v", err)
	}

	t.Setenv("GO_INGESTION_TASK_STORE_BACKEND", "sqlite")
	t.Setenv("GO_INGESTION_TASK_STORE_SQLITE_PATH", filepath.Join(t.TempDir(), "task-store.db"))
	t.Setenv("GO_INGESTION_TASK_STORE_BOOTSTRAP_JSON_PATH", malformed)
	t.Setenv("GO_INGESTION_TASK_STORE_FALLBACK", "json")
	t.Setenv("GO_INGESTION_TASK_STORE_PATH", filepath.Join(t.TempDir(), "task-store.json"))

	repo, err := ResolveFromEnv()
	if err != nil {
		t.Fatalf("expected fallback to json, got error: %v", err)
	}
	if _, ok := repo.(*jsonstore.Store); !ok {
		t.Fatalf("expected *jsonstore.Store fallback, got %T", repo)
	}
}

func TestResolveFromEnv_MySQLFallsBackToJSON(t *testing.T) {
	t.Setenv("GO_INGESTION_TASK_STORE_BACKEND", "mysql")
	t.Setenv("GO_INGESTION_TASK_STORE_MYSQL_DSN", "bad-dsn")
	t.Setenv("GO_INGESTION_TASK_STORE_FALLBACK", "json")
	t.Setenv("GO_INGESTION_TASK_STORE_PATH", filepath.Join(t.TempDir(), "task-store.json"))

	repo, err := ResolveFromEnv()
	if err != nil {
		t.Fatalf("expected fallback to json, got error: %v", err)
	}
	if _, ok := repo.(*jsonstore.Store); !ok {
		t.Fatalf("expected *jsonstore.Store fallback, got %T", repo)
	}
}

func TestResolveFromEnv_MySQLFallsBackToSQLite(t *testing.T) {
	t.Setenv("GO_INGESTION_TASK_STORE_BACKEND", "mysql")
	t.Setenv("GO_INGESTION_TASK_STORE_MYSQL_DSN", "bad-dsn")
	t.Setenv("GO_INGESTION_TASK_STORE_FALLBACK", "sqlite")
	t.Setenv("GO_INGESTION_TASK_STORE_SQLITE_PATH", filepath.Join(t.TempDir(), "task-store.db"))

	repo, err := ResolveFromEnv()
	if err != nil {
		t.Fatalf("expected fallback to sqlite, got error: %v", err)
	}
	sqliteRepo, ok := repo.(*sqlitestore.Store)
	if !ok {
		t.Fatalf("expected *sqlitestore.Store fallback, got %T", repo)
	}
	t.Cleanup(func() {
		_ = sqliteRepo.Close()
	})
}
