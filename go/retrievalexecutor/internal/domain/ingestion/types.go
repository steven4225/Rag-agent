package ingestion

import "context"

const (
	StatusPending   = "pending"
	StatusRunning   = "running"
	StatusSucceeded = "succeeded"
	StatusFailed    = "failed"

	StageQueued    = "queued"
	StageClaimed   = "worker-claimed"
	StageParser    = "parser"
	StageChunker   = "chunker"
	StageEmbedding = "embedding"
	StageIndexing  = "indexing"
	StageCompleted = "completed"
	StageFailed    = "failed"
	StageRetry     = "retry-scheduled"
)

type Source struct {
	SourceType string
	URI        string
	Filename   string
	MimeType   string
	SizeBytes  int64
	Checksum   string
}

type ParserExecutionPlan struct {
	ParserType string
	Mode       string
}

type ChunkingExecutionPlan struct {
	Strategy   string
	TargetSize int
	Overlap    int
}

type EmbeddingExecutionPlan struct {
	Enabled bool
	Model   string
	Adapter string
}

type IndexingExecutionPlan struct {
	Enabled   bool
	IndexName string
	StoreType string
}

type ExecutionPlan struct {
	Parser    ParserExecutionPlan
	Chunking  ChunkingExecutionPlan
	Embedding EmbeddingExecutionPlan
	Indexing  IndexingExecutionPlan
}

type TaskCreateInput struct {
	TraceID         string
	KnowledgeBaseID string
	DocumentID      string
	RequestedBy     string
	Source          Source
	ExecutionPlan   ExecutionPlan
	Metadata        map[string]any
}

type ParsedSection struct {
	SectionID   string
	Title       string
	Level       int
	Text        string
	StartOffset int
	EndOffset   int
}

type ParsedDocument struct {
	DocumentID string
	Title      string
	MimeType   string
	Language   string
	CharCount  int
	PageCount  *int
	Metadata   map[string]any
	Text       string
	Sections   []ParsedSection
}

type ChunkMetadata struct {
	SectionPath []string
	StartOffset int
	EndOffset   int
	PageNumber  *int
}

type Chunk struct {
	ChunkID    string
	DocumentID string
	ChunkIndex int
	Text       string
	CharCount  int
	TokenCount *int
	Metadata   ChunkMetadata
}

type EmbeddingInput struct {
	ChunkID      string
	DocumentID   string
	ChunkIndex   int
	Text         string
	CharCount    int
	ContentHash  string
	Metadata     ChunkMetadata
	KnowledgeRef map[string]any
}

type EmbeddingRequest struct {
	TraceID         string
	TaskID          string
	KnowledgeBaseID string
	DocumentID      string
	Model           string
	Inputs          []EmbeddingInput
	Metadata        map[string]any
}

type EmbeddingArtifact struct {
	ChunkID      string
	Vector       []float32
	Dimensions   int
	ContentHash  string
	EmbeddingRef string
	Source       string
	Metadata     map[string]any
}

type EmbeddingResult struct {
	Status       string
	Model        string
	Source       string
	VectorCount  int
	Dimensions   int
	Artifacts    []EmbeddingArtifact
	ErrorMessage string
	Metadata     map[string]any
}

type IndexRecord struct {
	RecordID        string
	KnowledgeBaseID string
	DocumentID      string
	ChunkID         string
	ChunkIndex      int
	Title           string
	Content         string
	EmbeddingRef    string
	Vector          []float32
	Source          string
	TenantID        string
	OrgID           string
	Metadata        map[string]any
}

type IndexWriteRequest struct {
	TraceID         string
	TaskID          string
	KnowledgeBaseID string
	DocumentID      string
	IndexName       string
	Operation       string
	IdempotencyKey  string
	Records         []IndexRecord
	Metadata        map[string]any
}

type IndexWriteResult struct {
	Status              string
	IndexName           string
	StoreType           string
	Source              string
	Operation           string
	RecordCount         int
	IndexedChunkCount   int
	SkippedRecordCount  int
	ReplacedRecordCount int
	DeletedRecordCount  int
	Records             []IndexRecord
	ErrorMessage        string
	Metadata            map[string]any
}

type ParseRequest struct {
	TaskID          string
	TraceID         string
	DocumentID      string
	KnowledgeBaseID string
	Source          Source
	Plan            ExecutionPlan
}

type ParseResult struct {
	ParserBackend  string
	ParserName     string
	ParserVersion  string
	Status         string
	Warnings       []string
	ParsedDocument *ParsedDocument
	Metrics        ParserMetrics
	ErrorMessage   string
}

type ParserMetrics struct {
	ParseDurationMs int64
	ChunkDurationMs int64
}

type TraceEvent struct {
	TraceID   string
	TaskID    string
	Stage     string
	Level     string
	Status    string
	Message   string
	Timestamp string
	Metadata  map[string]any
}

type TaskStatus struct {
	TaskID           string
	TraceID          string
	KnowledgeBaseID  string
	DocumentID       string
	RequestedBy      string
	Source           Source
	Status           string
	CurrentStage     string
	AttemptCount     int
	MaxAttempts      int
	Retryable        bool
	NextRunAt        string
	RetryAfterSec    int
	FailureReason    string
	FailureStage     string
	CreatedAt        string
	UpdatedAt        string
	StartedAt        string
	FinishedAt       string
	ErrorMessage     string
	ExecutionPlan    ExecutionPlan
	ParserResult     *ParseResult
	EmbeddingResult  *EmbeddingResult
	IndexWriteResult *IndexWriteResult
	Chunks           []Chunk
	Trace            []TraceEvent
	Metadata         map[string]any
}

type ParserAdapter interface {
	Parse(ctx context.Context, request ParseRequest) (ParseResult, error)
}

type Chunker interface {
	Split(ctx context.Context, document ParsedDocument, plan ChunkingExecutionPlan) ([]Chunk, int64, error)
}

type EmbeddingAdapter interface {
	Embed(ctx context.Context, request EmbeddingRequest) (EmbeddingResult, error)
}

type TaskRepository interface {
	Upsert(ctx context.Context, task TaskStatus) error
	Get(ctx context.Context, taskID string) (TaskStatus, error)
	FindByIdempotencyKey(ctx context.Context, idempotencyKey string) (TaskStatus, error)
	ListByKnowledgeBase(ctx context.Context, knowledgeBaseID string, limit int) ([]TaskStatus, error)
	ListRecent(ctx context.Context, limit int) ([]TaskStatus, error)
}
