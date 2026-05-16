package resolver

import "testing"

func TestResolveDefaultsToJSONBackend(t *testing.T) {
	store, err := Resolve(Config{})
	if err != nil {
		t.Fatalf("expected default json backend, got error: %v", err)
	}
	if store == nil {
		t.Fatalf("expected resolved store")
	}
}

func TestResolveQdrantFailsWithoutFallback(t *testing.T) {
	_, err := Resolve(Config{
		Backend:       BackendQdrant,
		QdrantURL:     "://bad-url",
		Fallback:      "",
		JSONStorePath: "",
	})
	if err == nil {
		t.Fatalf("expected qdrant init error without fallback")
	}
}

func TestResolveQdrantFallsBackToJSONWhenConfigured(t *testing.T) {
	store, err := Resolve(Config{
		Backend:       BackendQdrant,
		QdrantURL:     "://bad-url",
		Fallback:      BackendJSON,
		JSONStorePath: "",
	})
	if err != nil {
		t.Fatalf("expected fallback to json, got error: %v", err)
	}
	if store == nil {
		t.Fatalf("expected resolved json fallback store")
	}
}

func TestResolveFailsWhenMetadataStoreCannotInitialize(t *testing.T) {
	_, err := Resolve(Config{
		Backend:                 BackendJSON,
		IndexMetadataBackend:    "sqlite",
		IndexMetadataSQLitePath: "NUL\\bad\\path\\index-metadata.db",
		IndexMetadataFallback:   "",
	})
	if err == nil {
		t.Fatalf("expected metadata store resolve error")
	}
}

func TestResolveMetadataStoreFallsBackToJSONWhenConfigured(t *testing.T) {
	store, err := Resolve(Config{
		Backend:                 BackendJSON,
		IndexMetadataBackend:    "sqlite",
		IndexMetadataSQLitePath: "NUL\\bad\\path\\index-metadata.db",
		IndexMetadataFallback:   "json",
	})
	if err != nil {
		t.Fatalf("expected metadata fallback to json, got error: %v", err)
	}
	if store == nil {
		t.Fatalf("expected resolved store with metadata fallback")
	}
}

func TestResolveMetadataStoreMySQLFallsBackToJSONWhenConfigured(t *testing.T) {
	store, err := Resolve(Config{
		Backend:               BackendJSON,
		IndexMetadataBackend:  "mysql",
		IndexMetadataMySQLDSN: "bad-dsn",
		IndexMetadataFallback: "json",
	})
	if err != nil {
		t.Fatalf("expected metadata mysql fallback to json, got error: %v", err)
	}
	if store == nil {
		t.Fatalf("expected resolved store with metadata mysql fallback")
	}
}
