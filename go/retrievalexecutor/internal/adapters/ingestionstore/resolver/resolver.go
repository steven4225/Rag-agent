package resolver

import (
	"fmt"
	"os"
	"strings"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestionstore"
	jsonstore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestionstore/jsonstore"
	mysqlstore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestionstore/mysqlstore"
	sqlitestore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/ingestionstore/sqlitestore"
)

const (
	BackendJSON   = "json"
	BackendSQLite = "sqlite"
	BackendMySQL  = "mysql"
)

// ResolveFromEnv centralizes ingestion task store backend selection.
// Production can switch backend implementation here without changing worker/service wiring.
func ResolveFromEnv() (ingestionstore.Repository, error) {
	config := Config{
		Backend:           strings.TrimSpace(os.Getenv("GO_INGESTION_TASK_STORE_BACKEND")),
		Fallback:          strings.TrimSpace(os.Getenv("GO_INGESTION_TASK_STORE_FALLBACK")),
		JSONPath:          strings.TrimSpace(os.Getenv("GO_INGESTION_TASK_STORE_PATH")),
		SQLitePath:        strings.TrimSpace(os.Getenv("GO_INGESTION_TASK_STORE_SQLITE_PATH")),
		MySQLDSN:          strings.TrimSpace(os.Getenv("GO_INGESTION_TASK_STORE_MYSQL_DSN")),
		GlobalMySQLDSN:    strings.TrimSpace(os.Getenv("MYSQL_DSN")),
		BootstrapJSONPath: strings.TrimSpace(os.Getenv("GO_INGESTION_TASK_STORE_BOOTSTRAP_JSON_PATH")),
	}
	return Resolve(config)
}

type Config struct {
	Backend           string
	Fallback          string
	JSONPath          string
	SQLitePath        string
	MySQLDSN          string
	GlobalMySQLDSN    string
	BootstrapJSONPath string
}

func Resolve(config Config) (ingestionstore.Repository, error) {
	backend := strings.ToLower(strings.TrimSpace(config.Backend))
	if backend == "" {
		backend = BackendJSON
	}

	fallback := strings.ToLower(strings.TrimSpace(config.Fallback))
	bootstrapJSONPath := strings.TrimSpace(config.BootstrapJSONPath)
	if bootstrapJSONPath == "" {
		bootstrapJSONPath = strings.TrimSpace(config.JSONPath)
	}
	config.BootstrapJSONPath = bootstrapJSONPath

	store, err := resolveByBackend(backend, config)
	if err == nil {
		return store, nil
	}

	if fallback != "" && fallback != backend {
		fallbackStore, fallbackErr := resolveByBackend(fallback, config)
		if fallbackErr == nil {
			return fallbackStore, nil
		}
		return nil, fmt.Errorf("initialize %s ingestion task store backend failed: %w (fallback=%s failed: %v)", backend, err, fallback, fallbackErr)
	}

	return nil, fmt.Errorf("initialize %s ingestion task store backend failed: %w", backend, err)
}

func resolveByBackend(backend string, config Config) (ingestionstore.Repository, error) {
	backend = strings.ToLower(strings.TrimSpace(backend))
	if backend == "" {
		backend = BackendJSON
	}

	switch backend {
	case BackendJSON:
		return jsonstore.NewStore(config.JSONPath), nil
	case BackendSQLite:
		return sqlitestore.NewStore(sqlitestore.Config{
			Path:              config.SQLitePath,
			BootstrapJSONPath: config.BootstrapJSONPath,
		})
	case BackendMySQL:
		dsn := strings.TrimSpace(config.MySQLDSN)
		if dsn == "" {
			dsn = strings.TrimSpace(config.GlobalMySQLDSN)
		}
		return mysqlstore.NewStore(mysqlstore.Config{
			DSN:               dsn,
			BootstrapJSONPath: config.BootstrapJSONPath,
		})
	}
	return nil, fmt.Errorf("unsupported GO_INGESTION_TASK_STORE_BACKEND=%q", backend)
}
