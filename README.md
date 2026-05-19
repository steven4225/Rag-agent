# Ragent

A Retrieval-Augmented Generation (RAG) platform with hybrid search, multi-backend storage, and an extensible agent runtime. Built with a TypeScript orchestration layer and a Go retrieval executor, packaged as a Docker Compose stack.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Web (Next.js 16 · React 19 · TypeScript)       │
│  Chat UI · Admin Dashboard · RAG Orchestrator   │
│  MCP Runtime · Evaluation Framework             │
└──────────────────┬──────────────────────────────┘
                   │ HTTP (internal API)
┌──────────────────▼──────────────────────────────┐
│  Go Retrieval Executor (Go 1.23)                │
│  Hybrid Search · Document Ingestion             │
│  Embedding · Chunking · Reranking               │
└──────┬──────────────────────────┬───────────────┘
       │                          │
┌──────▼──────┐          ┌───────▼───────┐
│  Qdrant     │          │  BGE Reranker │
│  (Vector DB)│          │  V2-M3        │
└─────────────┘          └───────────────┘
```

- **Web** — Next.js app handling chat, knowledge-base CRUD, ingestion orchestration, and the MCP tool runtime. Retrieval planning stays in TypeScript; execution is delegated to Go.
- **Go Retrieval Executor** — Standalone HTTP service that runs hybrid (vector + keyword) search, manages document ingestion pipelines, and resolves storage backends at startup.
- **Qdrant** — Vector database for semantic search.
- **BGE Reranker** — Cross-encoder reranker for result quality.

## Features

- Hybrid retrieval combining vector search and keyword matching
- Document ingestion with text chunking, embedding generation, and indexing
- Multi-backend storage — choose SQLite, MySQL, JSON, or Qdrant per component
- Admin dashboard for managing knowledge bases, documents, intents, users, and traces
- MCP (Model Context Protocol) runtime for tool-augmented generation
- Built-in evaluation framework (answer relevance, context precision/recall, faithfulness)
- OIDC authentication support
- Feedback collection and conversation tracing

## Quick Start

### Prerequisites

- Docker & Docker Compose

### Run the full stack

```bash
cp .env.example .env
# Edit .env and set your secrets, then:
docker compose up -d
```

The stack starts:

| Service          | Port |
| ---------------- | ---- |
| Web UI           | 3000 |
| Go Retrieval API | 8090 |
| Qdrant           | 6333 |
| BGE Reranker     | 8091 |

Open `http://localhost:3000` to access the chat interface.

### Development

**Web (Next.js):**
```bash
cd web
cp ../.env.example .env
npm ci
npm run dev          # starts on :3000
npm run typecheck    # TypeScript check
npm run lint         # ESLint
```

**Go service:**
```bash
cd go/retrievalexecutor
go test ./...        # run tests
go build -o service ./cmd/retrieval-service
```

## Configuration

Key environment variables (see `.env.example` for the full list):

| Variable                          | Description                        |
| --------------------------------- | ---------------------------------- |
| `PORT`                            | Go service port (default: `8090`)  |
| `INTERNAL_API_TOKEN`              | Internal API auth token            |
| `AUTH_SESSION_SECRET`             | Session encryption secret          |
| `GO_RETRIEVAL_MODE`               | `hybrid` / `vector` / `keyword`    |
| `GO_RETRIEVAL_SOURCE`             | `indexed-store` / `local-corpus`   |
| `GO_INDEX_VECTOR_STORE_BACKEND`   | `qdrant` / `json`                  |
| `GO_INDEX_METADATA_STORE_BACKEND` | `sqlite` / `mysql` / `json`        |
| `GO_INGESTION_TASK_STORE_BACKEND` | `sqlite` / `mysql` / `json`        |
| `QDRANT_URL`                      | Qdrant server URL                  |
| `BGE_RERANKER_URL`                | Reranker endpoint                  |

## Storage Backends

Each storage concern is independently configurable via environment variables, with a resolver that selects the backend at startup. This lets you run lightweight with SQLite for development and switch to MySQL + Qdrant for production — without code changes.

| Concern         | Options               |
| --------------- | --------------------- |
| Vector Index    | Qdrant, JSON          |
| Index Metadata  | MySQL, SQLite, JSON   |
| Ingestion Tasks | MySQL, SQLite, JSON   |

## E2E Verification

```bash
cd web
npm run verify:rag-e2e              # RAG pipeline
npm run verify:async-ingestion-e2e   # Async ingestion
npm run verify:auth-scope-e2e        # Auth scopes
npm run verify:vector-db-e2e         # Vector DB integration
npm run verify:mcp-runtime-e2e       # MCP runtime
npm run verify:smoke-phase1          # All phase-1 checks
```

## License

[Apache 2.0](LICENSE)
