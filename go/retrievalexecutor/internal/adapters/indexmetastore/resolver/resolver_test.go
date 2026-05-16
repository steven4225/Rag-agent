package resolver

import (
	"testing"

	jsonstore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexmetastore/jsonstore"
	sqlitestore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexmetastore/sqlitestore"
)

func TestResolveDefaultsToSQLiteBackend(t *testing.T) {
	store, err := Resolve(Config{})
	if err != nil {
		t.Fatalf("expected default sqlite backend, got error: %v", err)
	}
	if _, ok := store.(*sqlitestore.Store); !ok {
		t.Fatalf("expected *sqlitestore.Store, got %T", store)
	}
}

func TestResolveFallsBackToJSONWhenSQLiteInitFails(t *testing.T) {
	store, err := Resolve(Config{
		Backend:    BackendSQLite,
		SQLitePath: "NUL\\bad\\path\\index-metadata.db",
		JSONPath:   "",
		Fallback:   BackendJSON,
	})
	if err != nil {
		t.Fatalf("expected fallback to json, got error: %v", err)
	}
	if _, ok := store.(*jsonstore.Store); !ok {
		t.Fatalf("expected *jsonstore.Store fallback, got %T", store)
	}
}

func TestResolveJSONBackend(t *testing.T) {
	store, err := Resolve(Config{
		Backend: BackendJSON,
	})
	if err != nil {
		t.Fatalf("expected json backend, got error: %v", err)
	}
	if _, ok := store.(*jsonstore.Store); !ok {
		t.Fatalf("expected *jsonstore.Store, got %T", store)
	}
}

func TestResolveMySQLFallsBackToJSON(t *testing.T) {
	store, err := Resolve(Config{
		Backend:  BackendMySQL,
		MySQLDSN: "bad-dsn",
		Fallback: BackendJSON,
	})
	if err != nil {
		t.Fatalf("expected fallback to json, got error: %v", err)
	}
	if _, ok := store.(*jsonstore.Store); !ok {
		t.Fatalf("expected *jsonstore.Store fallback, got %T", store)
	}
}

func TestResolveMySQLFallsBackToSQLite(t *testing.T) {
	store, err := Resolve(Config{
		Backend:    BackendMySQL,
		MySQLDSN:   "bad-dsn",
		Fallback:   BackendSQLite,
		SQLitePath: "",
	})
	if err != nil {
		t.Fatalf("expected fallback to sqlite, got error: %v", err)
	}
	if _, ok := store.(*sqlitestore.Store); !ok {
		t.Fatalf("expected *sqlitestore.Store fallback, got %T", store)
	}
}
