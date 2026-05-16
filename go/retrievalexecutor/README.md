# Go Retrieval Executor Phase 1

This service is the first Go-side retrieval executor for the mixed TS + Go architecture.

## Module layout

- `cmd/retrieval-service`
  - runnable HTTP service entrypoint
- `internal/transport/http`
  - internal HTTP routes and request handling
- `internal/application/service`
  - request validation and contract-to-domain mapping
- `internal/domain/retrieval`
  - executor abstractions, retrieval source selection, and retrieval domain types
- `internal/adapters/local-corpus`
  - local mock corpus retrieval source
- `internal/adapters/retrieval/indexedsource`
  - index-backed retrieval source that reads JSON index records
- `internal/adapters/retrieval/sourceexecutor`
  - source-selecting executor with fallback behavior
- `internal/adapters/indexstore/jsonstore`
  - JSON-backed index store used by ingestion and retrieval
- `internal/adapters/indexmetastore/{resolver,mysqlstore,sqlitestore,jsonstore}`
  - index metadata persistence adapter/resolver baseline (`mysql`/`sqlite`/`json` via resolver)
- `internal/adapters/indexstore/metadata_persisting_adapter.go`
  - composes vector index backend with metadata persistence without changing business-layer contracts
- `internal/adapters/ingestionstore/resolver`
  - ingestion task store backend resolver (`mysql`/`sqlite`/`json` with fallback)
- `internal/adapters/ingestionstore/{mysqlstore,sqlitestore}`
  - restart-safe ingestion task stores for worker/retry/recovery baseline
- `pkg/contracts`
  - TS/Go retrieval request-response boundary structs

## Current contract

- `POST /internal/retrieval/search`
- required fields:
  - `traceId`
  - `query`
- optional fields:
  - `conversationId`
  - `userId`
  - `knowledgeBaseIds`
  - `topK`
  - `filters`

The response preserves the TS retrieval shape with:

- `traceId`
- `chunks`
- `timing.totalMs`
- `source`

It also includes Phase 1 helper fields:

- `total`
- `latencyMs`

## Retrieval source selection

The Go executor keeps TS retrieval planning unchanged and only decides how to execute the search against a configured source.

- `GO_RETRIEVAL_SOURCE=local-corpus`
  - always search the local mock corpus
- `GO_RETRIEVAL_SOURCE=indexed-store`
  - search the JSON-backed index store created by ingestion
- `GO_RETRIEVAL_FALLBACK_ENABLED=true|false`
  - when `indexed-store` is selected, fallback to `local-corpus` on empty results or source errors
- `GO_RETRIEVAL_INDEX_STORE_PATH=/path/to/index.json`
  - optional override for the shared JSON-backed index store path
- `GO_INDEX_METADATA_STORE_BACKEND=mysql|sqlite|json`
  - index metadata persistence backend (`mysql` recommended for production-like baseline)
- `GO_INDEX_METADATA_STORE_SQLITE_PATH=/path/to/index-metadata.db`
  - optional override when metadata backend is `sqlite`
- `GO_INDEX_METADATA_STORE_MYSQL_DSN=user:pass@tcp(127.0.0.1:3306)/dbname?parseTime=true&charset=utf8mb4`
  - optional override when metadata backend is `mysql` (takes precedence over `MYSQL_DSN`)
- `GO_INDEX_METADATA_STORE_FALLBACK=json`
  - optional fallback backend (`json`/`sqlite`) when metadata primary backend init fails in trial/dev
- `GO_INDEX_METADATA_STORE_PATH=/path/to/index-metadata.json`
  - optional override when metadata backend/fallback is `json`
- `GO_INGESTION_TASK_STORE_BACKEND=mysql|json|sqlite`
  - ingestion task persistence backend selector (`mysql` recommended for production-like baseline)
- `GO_INGESTION_TASK_STORE_PATH=/path/to/task-store.json`
  - optional override for ingestion task store path when backend is `json`
- `GO_INGESTION_TASK_STORE_SQLITE_PATH=/path/to/task-store.db`
  - optional override for ingestion task sqlite file path when backend is `sqlite`
- `GO_INGESTION_TASK_STORE_MYSQL_DSN=user:pass@tcp(127.0.0.1:3306)/dbname?parseTime=true&charset=utf8mb4`
  - optional override for ingestion task store when backend is `mysql` (takes precedence over `MYSQL_DSN`)
- `MYSQL_DSN=user:pass@tcp(127.0.0.1:3306)/dbname?parseTime=true&charset=utf8mb4`
  - shared default DSN for Go mysql-backed stores when store-specific DSN is omitted
- `GO_INGESTION_TASK_STORE_BOOTSTRAP_JSON_PATH=/path/to/task-store.json`
  - optional one-time bootstrap source for mysql/sqlite backend (imports only when DB is empty)
- `GO_INGESTION_TASK_STORE_FALLBACK=json|sqlite`
  - optional fallback backend when primary store init/bootstrap fails in trial/dev

When fallback happens, the HTTP contract stays stable and the response `source` reflects the actual source that served the result. Per-chunk metadata includes `requestedSource`, `actualSource`, and `fallbackReason` when relevant.

## Future-ready extension points

- `retrieval.VectorStoreAdapter`
- `retrieval.RerankAdapter`
- `retrieval.MetadataFilter`

These are placeholders for future vector search, reranking, and richer metadata filtering without moving orchestration out of TS.
