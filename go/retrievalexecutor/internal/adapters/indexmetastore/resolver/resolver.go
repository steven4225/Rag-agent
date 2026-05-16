package resolver

import (
	"fmt"
	"os"
	"strings"

	adapter "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexmetastore"
	jsonstore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexmetastore/jsonstore"
	mysqlstore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexmetastore/mysqlstore"
	sqlitestore "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexmetastore/sqlitestore"
)

const (
	BackendSQLite = "sqlite"
	BackendJSON   = "json"
	BackendMySQL  = "mysql"
)

type Config struct {
	Backend    string
	SQLitePath string
	JSONPath   string
	Fallback   string
	MySQLDSN   string
	GlobalDSN  string
}

func ResolveFromEnv() (adapter.Adapter, error) {
	return Resolve(Config{
		Backend:    strings.TrimSpace(os.Getenv("GO_INDEX_METADATA_STORE_BACKEND")),
		SQLitePath: strings.TrimSpace(os.Getenv("GO_INDEX_METADATA_STORE_SQLITE_PATH")),
		JSONPath:   strings.TrimSpace(os.Getenv("GO_INDEX_METADATA_STORE_PATH")),
		Fallback:   strings.TrimSpace(os.Getenv("GO_INDEX_METADATA_STORE_FALLBACK")),
		MySQLDSN:   strings.TrimSpace(os.Getenv("GO_INDEX_METADATA_STORE_MYSQL_DSN")),
		GlobalDSN:  strings.TrimSpace(os.Getenv("MYSQL_DSN")),
	})
}

func Resolve(config Config) (adapter.Adapter, error) {
	backend := strings.ToLower(strings.TrimSpace(config.Backend))
	if backend == "" {
		backend = BackendSQLite
	}

	store, err := resolveByBackend(backend, config)
	if err == nil {
		return store, nil
	}

	fallback := strings.ToLower(strings.TrimSpace(config.Fallback))
	if fallback != "" && fallback != backend {
		fallbackStore, fallbackErr := resolveByBackend(fallback, config)
		if fallbackErr == nil {
			return fallbackStore, nil
		}
		return nil, fmt.Errorf("initialize %s index metadata store backend failed: %w (fallback=%s failed: %v)", backend, err, fallback, fallbackErr)
	}

	return nil, fmt.Errorf("initialize %s index metadata store backend failed: %w", backend, err)
}

func resolveByBackend(backend string, config Config) (adapter.Adapter, error) {
	switch strings.ToLower(strings.TrimSpace(backend)) {
	case BackendSQLite:
		return sqlitestore.NewStore(sqlitestore.Config{
			Path: config.SQLitePath,
		})
	case BackendJSON:
		return jsonstore.NewStore(config.JSONPath), nil
	case BackendMySQL:
		dsn := strings.TrimSpace(config.MySQLDSN)
		if dsn == "" {
			dsn = strings.TrimSpace(config.GlobalDSN)
		}
		return mysqlstore.NewStore(mysqlstore.Config{DSN: dsn})
	}
	return nil, fmt.Errorf("unsupported GO_INDEX_METADATA_STORE_BACKEND=%q", backend)
}
