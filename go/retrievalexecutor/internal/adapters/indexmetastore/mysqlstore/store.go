package mysqlstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
	adapter "github.com/nageoffer/ragent/go/retrievalexecutor/internal/adapters/indexmetastore"
)

const (
	StoreType  = "mysql"
	SourceName = "go-mysql-index-metadata-store"
	driverName = "mysql"
)

type Config struct {
	DSN string
}

type Store struct {
	db  *sql.DB
	dsn string
}

func NewStore(config Config) (*Store, error) {
	dsn := strings.TrimSpace(config.DSN)
	if dsn == "" {
		return nil, fmt.Errorf("mysql dsn is required")
	}

	db, err := sql.Open(driverName, dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(30 * time.Minute)

	store := &Store{
		db:  db,
		dsn: dsn,
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
ON DUPLICATE KEY UPDATE
	knowledge_base_id = VALUES(knowledge_base_id),
	document_id = VALUES(document_id),
	chunk_id = VALUES(chunk_id),
	chunk_index = VALUES(chunk_index),
	index_name = VALUES(index_name),
	embedding_ref = VALUES(embedding_ref),
	source = VALUES(source),
	metadata_json = VALUES(metadata_json),
	updated_at = VALUES(updated_at)
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
			"filteredRecords": len(records),
			"totalRecords":    totalCount,
		},
	}, nil
}

func (s *Store) ensureSchema() error {
	schema := []string{
		`CREATE TABLE IF NOT EXISTS index_metadata_records (
			record_id VARCHAR(191) NOT NULL PRIMARY KEY,
			knowledge_base_id VARCHAR(191) NOT NULL,
			document_id VARCHAR(191) NOT NULL,
			chunk_id VARCHAR(191) NOT NULL,
			chunk_index INT NOT NULL,
			index_name VARCHAR(191) NOT NULL,
			embedding_ref VARCHAR(255),
			source VARCHAR(191),
			metadata_json LONGTEXT NOT NULL,
			updated_at VARCHAR(64) NOT NULL
		);`,
		`CREATE INDEX idx_index_metadata_kb_doc
			ON index_metadata_records(knowledge_base_id, document_id, chunk_index);`,
		`CREATE INDEX idx_index_metadata_kb
			ON index_metadata_records(knowledge_base_id, updated_at);`,
	}

	for _, query := range schema {
		if _, err := s.db.Exec(query); err != nil {
			if isDuplicateIndexError(err) {
				continue
			}
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

func isDuplicateIndexError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "duplicate key name")
}
