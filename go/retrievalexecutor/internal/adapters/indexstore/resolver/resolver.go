package resolver

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	indexmetadataresolver "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexmetastore/resolver"
	adapter "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexstore"
	jsonstore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexstore/jsonstore"
	qdrant "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexstore/qdrant"
)

const (
	BackendJSON   = "json"
	BackendQdrant = "qdrant"
)

type Config struct {
	Backend       string
	JSONStorePath string
	Fallback      string

	IndexMetadataBackend    string
	IndexMetadataSQLitePath string
	IndexMetadataJSONPath   string
	IndexMetadataFallback   string
	IndexMetadataMySQLDSN   string
	MySQLDSN                string

	QdrantURL        string
	QdrantAPIKey     string
	QdrantCollection string
	QdrantTimeout    time.Duration
}

func ResolveFromEnv() (adapter.Adapter, error) {
	config := Config{
		Backend:                 strings.TrimSpace(os.Getenv("INDEX_BACKEND")),
		JSONStorePath:           strings.TrimSpace(os.Getenv("GO_RETRIEVAL_INDEX_STORE_PATH")),
		Fallback:                strings.TrimSpace(os.Getenv("INDEX_BACKEND_FALLBACK")),
		IndexMetadataBackend:    strings.TrimSpace(os.Getenv("GO_INDEX_METADATA_STORE_BACKEND")),
		IndexMetadataSQLitePath: strings.TrimSpace(os.Getenv("GO_INDEX_METADATA_STORE_SQLITE_PATH")),
		IndexMetadataJSONPath:   strings.TrimSpace(os.Getenv("GO_INDEX_METADATA_STORE_PATH")),
		IndexMetadataFallback:   strings.TrimSpace(os.Getenv("GO_INDEX_METADATA_STORE_FALLBACK")),
		IndexMetadataMySQLDSN:   strings.TrimSpace(os.Getenv("GO_INDEX_METADATA_STORE_MYSQL_DSN")),
		MySQLDSN:                strings.TrimSpace(os.Getenv("MYSQL_DSN")),
		QdrantURL:               strings.TrimSpace(os.Getenv("QDRANT_URL")),
		QdrantAPIKey:            strings.TrimSpace(os.Getenv("QDRANT_API_KEY")),
		QdrantCollection:        strings.TrimSpace(os.Getenv("QDRANT_COLLECTION")),
		QdrantTimeout:           readTimeout("QDRANT_TIMEOUT_MS", 5*time.Second),
	}
	return Resolve(config)
}

func Resolve(config Config) (adapter.Adapter, error) {
	backend := strings.ToLower(strings.TrimSpace(config.Backend))
	if backend == "" {
		backend = BackendJSON
	}

	metadataStore, metadataErr := indexmetadataresolver.Resolve(indexmetadataresolver.Config{
		Backend:    config.IndexMetadataBackend,
		SQLitePath: config.IndexMetadataSQLitePath,
		JSONPath:   config.IndexMetadataJSONPath,
		Fallback:   config.IndexMetadataFallback,
		MySQLDSN:   config.IndexMetadataMySQLDSN,
		GlobalDSN:  config.MySQLDSN,
	})
	if metadataErr != nil {
		return nil, fmt.Errorf("resolve index metadata store failed: %w", metadataErr)
	}

	switch backend {
	case BackendJSON:
		return adapter.NewMetadataPersistingAdapter(jsonstore.NewStore(config.JSONStorePath), metadataStore), nil
	case BackendQdrant:
		store, err := qdrant.NewStore(qdrant.Config{
			URL:        config.QdrantURL,
			APIKey:     config.QdrantAPIKey,
			Collection: config.QdrantCollection,
			Timeout:    config.QdrantTimeout,
		})
		if err == nil {
			return adapter.NewMetadataPersistingAdapter(store, metadataStore), nil
		}

		if strings.EqualFold(strings.TrimSpace(config.Fallback), BackendJSON) {
			return adapter.NewMetadataPersistingAdapter(jsonstore.NewStore(config.JSONStorePath), metadataStore), nil
		}
		return nil, fmt.Errorf("initialize qdrant index backend failed: %w", err)
	default:
		return nil, fmt.Errorf("unsupported INDEX_BACKEND=%q", backend)
	}
}

func readTimeout(key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	parsedMs, err := strconv.Atoi(raw)
	if err != nil || parsedMs <= 0 {
		return fallback
	}
	return time.Duration(parsedMs) * time.Millisecond
}
