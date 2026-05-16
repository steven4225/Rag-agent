package sqlitestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	adapter "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexmetastore"
	_ "modernc.org/sqlite"
)

const (
	DefaultStorePath = "tmp/go-index-metadata-store.db"
	StoreType        = "sqlite"
	SourceName       = "go-sqlite-index-metadata-store"
	driverName       = "sqlite"
)

type Config struct {
	Path string
}

type Store struct {
	db   *sql.DB
	path string
}

func NewStore(config Config) (*Store, error) {
	path := strings.TrimSpace(config.Path)
	if path == "" {
		path = DefaultStorePath
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}

	db, err := sql.Open(driverName, path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	store := &Store{
		db:   db,
		path: path,
	}
	if err := store.configure(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := store.ensureSchema(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) Upsert(ctx context.Context, request adapter.UpsertRequest) (adapter.WriteResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return adapter.WriteResult{}, wrapStoreError(adapter.OperationUpsert, err)
	}
	defer tx.Rollback()

	nowText := time.Now().UTC().Format(time.RFC3339)
	persistedRecordIDs := make([]string, 0, len(request.Records))
	for _, record := range request.Records {
		recordID := strings.TrimSpace(record.RecordID)
		if recordID == "" {
			continue
		}
		metadataBytes, err := json.Marshal(cloneMap(record.Metadata))
		if err != nil {
			return adapter.WriteResult{}, wrapStoreError(adapter.OperationUpsert, err)
		}

		_, err = tx.ExecContext(ctx, `
INSERT INTO index_metadata_records (
	record_id,
	knowledge_base_id,
	document_id,
	chunk_id,
	chunk_index,
	index_name,
	embedding_ref,
	source,
	metadata_json,
	updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(record_id) DO UPDATE SET
	knowledge_base_id = excluded.knowledge_base_id,
	document_id = excluded.document_id,
	chunk_id = excluded.chunk_id,
	chunk_index = excluded.chunk_index,
	index_name = excluded.index_name,
	embedding_ref = excluded.embedding_ref,
	source = excluded.source,
	metadata_json = excluded.metadata_json,
	updated_at = excluded.updated_at
`, recordID, record.KnowledgeBaseID, record.DocumentID, record.ChunkID, record.ChunkIndex,
			strings.TrimSpace(request.IndexName), record.EmbeddingRef, record.Source, string(metadataBytes), nowText)
		if err != nil {
			return adapter.WriteResult{}, wrapStoreError(adapter.OperationUpsert, err)
		}
		persistedRecordIDs = append(persistedRecordIDs, recordID)
	}

	if err := tx.Commit(); err != nil {
		return adapter.WriteResult{}, wrapStoreError(adapter.OperationUpsert, err)
	}

	totalCount, err := s.countRecords(ctx)
	if err != nil {
		return adapter.WriteResult{}, wrapStoreError(adapter.OperationUpsert, err)
	}

	return adapter.WriteResult{
		Source:              SourceName,
		StoreType:           StoreType,
		PersistedRecordIDs:  append([]string{}, persistedRecordIDs...),
		PersistedRecordSize: len(persistedRecordIDs),
		Metadata: map[string]any{
			"storePath":          s.path,
			"totalStoredRecords": totalCount,
		},
	}, nil
}

func (s *Store) DeleteByDocument(ctx context.Context, request adapter.DeleteByDocumentRequest) (adapter.DeleteResult, error) {
	result, err := s.db.ExecContext(ctx, `
DELETE FROM index_metadata_records
WHERE knowledge_base_id = ? AND document_id = ?`, request.KnowledgeBaseID, request.DocumentID)
	if err != nil {
		return adapter.DeleteResult{}, wrapStoreError(adapter.OperationDeleteByDocument, err)
	}

	deleted, err := result.RowsAffected()
	if err != nil {
		return adapter.DeleteResult{}, wrapStoreError(adapter.OperationDeleteByDocument, err)
	}

	totalCount, err := s.countRecords(ctx)
	if err != nil {
		return adapter.DeleteResult{}, wrapStoreError(adapter.OperationDeleteByDocument, err)
	}

	return adapter.DeleteResult{
		Source:             SourceName,
		StoreType:          StoreType,
		DeletedRecordCount: int(deleted),
		Metadata: map[string]any{
			"storePath":          s.path,
			"totalStoredRecords": totalCount,
		},
	}, nil
}

func (s *Store) DeleteByKnowledgeBase(ctx context.Context, request adapter.DeleteByKnowledgeBaseRequest) (adapter.DeleteResult, error) {
	result, err := s.db.ExecContext(ctx, `
DELETE FROM index_metadata_records
WHERE knowledge_base_id = ?`, request.KnowledgeBaseID)
	if err != nil {
		return adapter.DeleteResult{}, wrapStoreError(adapter.OperationDeleteByKnowledgeBase, err)
	}

	deleted, err := result.RowsAffected()
	if err != nil {
		return adapter.DeleteResult{}, wrapStoreError(adapter.OperationDeleteByKnowledgeBase, err)
	}

	totalCount, err := s.countRecords(ctx)
	if err != nil {
		return adapter.DeleteResult{}, wrapStoreError(adapter.OperationDeleteByKnowledgeBase, err)
	}

	return adapter.DeleteResult{
		Source:             SourceName,
		StoreType:          StoreType,
		DeletedRecordCount: int(deleted),
		Metadata: map[string]any{
			"storePath":          s.path,
			"totalStoredRecords": totalCount,
		},
	}, nil
}

func (s *Store) ListByDocument(ctx context.Context, request adapter.ListByDocumentRequest) (adapter.ListResult, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT
	record_id,
	knowledge_base_id,
	document_id,
	chunk_id,
	chunk_index,
	index_name,
	embedding_ref,
	source,
	metadata_json,
	updated_at
FROM index_metadata_records
WHERE knowledge_base_id = ? AND document_id = ?
ORDER BY chunk_index ASC, record_id ASC`, request.KnowledgeBaseID, request.DocumentID)
	if err != nil {
		return adapter.ListResult{}, wrapStoreError(adapter.OperationListByDocument, err)
	}
	defer rows.Close()

	records := []adapter.IndexRecordMetadata{}
	for rows.Next() {
		var (
			record       adapter.IndexRecordMetadata
			metadataJSON string
		)
		if err := rows.Scan(
			&record.RecordID,
			&record.KnowledgeBaseID,
			&record.DocumentID,
			&record.ChunkID,
			&record.ChunkIndex,
			&record.IndexName,
			&record.EmbeddingRef,
			&record.Source,
			&metadataJSON,
			&record.UpdatedAt,
		); err != nil {
			return adapter.ListResult{}, wrapStoreError(adapter.OperationListByDocument, err)
		}

		metadata := map[string]any{}
		if strings.TrimSpace(metadataJSON) != "" {
			if err := json.Unmarshal([]byte(metadataJSON), &metadata); err != nil {
				return adapter.ListResult{}, wrapStoreError(adapter.OperationListByDocument, err)
			}
		}
		record.Metadata = metadata
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return adapter.ListResult{}, wrapStoreError(adapter.OperationListByDocument, err)
	}

	totalCount, err := s.countRecords(ctx)
	if err != nil {
		return adapter.ListResult{}, wrapStoreError(adapter.OperationListByDocument, err)
	}

	return adapter.ListResult{
		Source:    SourceName,
		StoreType: StoreType,
		Records:   records,
		Metadata: map[string]any{
			"storePath":       s.path,
			"filteredRecords": len(records),
			"totalRecords":    totalCount,
		},
	}, nil
}

func (s *Store) configure() error {
	queries := []string{
		"PRAGMA journal_mode = WAL;",
		"PRAGMA synchronous = NORMAL;",
		"PRAGMA busy_timeout = 5000;",
	}
	for _, query := range queries {
		if _, err := s.db.Exec(query); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) ensureSchema() error {
	schema := []string{
		`CREATE TABLE IF NOT EXISTS index_metadata_records (
			record_id TEXT PRIMARY KEY,
			knowledge_base_id TEXT NOT NULL,
			document_id TEXT NOT NULL,
			chunk_id TEXT NOT NULL,
			chunk_index INTEGER NOT NULL,
			index_name TEXT NOT NULL,
			embedding_ref TEXT,
			source TEXT,
			metadata_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);`,
		`CREATE INDEX IF NOT EXISTS idx_index_metadata_kb_doc
			ON index_metadata_records(knowledge_base_id, document_id, chunk_index);`,
		`CREATE INDEX IF NOT EXISTS idx_index_metadata_kb
			ON index_metadata_records(knowledge_base_id, updated_at DESC);`,
	}

	for _, query := range schema {
		if _, err := s.db.Exec(query); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) countRecords(ctx context.Context) (int, error) {
	row := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM index_metadata_records`)
	var count int
	if err := row.Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func wrapStoreError(operation string, err error) error {
	return adapter.StoreError{
		Source:    SourceName,
		Operation: operation,
		Retryable: true,
		Err:       err,
	}
}

func cloneMap(source map[string]any) map[string]any {
	if len(source) == 0 {
		return map[string]any{}
	}
	cloned := make(map[string]any, len(source))
	for key, value := range source {
		cloned[key] = value
	}
	return cloned
}
