package contracts

type IngestionSource struct {
	SourceType string `json:"sourceType"`
	URI        string `json:"uri"`
	Filename   string `json:"filename"`
	MimeType   string `json:"mimeType"`
	SizeBytes  int64  `json:"sizeBytes"`
	Checksum   string `json:"checksum,omitempty"`
}

type ParserExecutionPlan struct {
	ParserType string `json:"parserType"`
	Mode       string `json:"mode"`
}

type ChunkingExecutionPlan struct {
	Strategy   string `json:"strategy"`
	TargetSize int    `json:"targetSize"`
	Overlap    int    `json:"overlap"`
}

type EmbeddingExecutionPlan struct {
	Enabled bool   `json:"enabled"`
	Model   string `json:"model,omitempty"`
	Adapter string `json:"adapter,omitempty"`
}

type IndexingExecutionPlan struct {
	Enabled   bool   `json:"enabled"`
	IndexName string `json:"indexName,omitempty"`
	StoreType string `json:"storeType,omitempty"`
}

type IngestionExecutionPlan struct {
	Parser    ParserExecutionPlan    `json:"parser"`
	Chunking  ChunkingExecutionPlan  `json:"chunking"`
	Embedding EmbeddingExecutionPlan `json:"embedding"`
	Indexing  IndexingExecutionPlan  `json:"indexing"`
}

type IngestionTaskCreateRequest struct {
	TraceID         string                 `json:"traceId"`
	KnowledgeBaseID string                 `json:"knowledgeBaseId"`
	DocumentID      string                 `json:"documentId"`
	RequestedBy     string                 `json:"requestedBy"`
	Source          IngestionSource        `json:"source"`
	ExecutionPlan   IngestionExecutionPlan `json:"executionPlan"`
	Metadata        map[string]any         `json:"metadata,omitempty"`
}

type ParsedSection struct {
	SectionID string `json:"sectionId"`
	Title     string `json:"title"`
	Level     int    `json:"level"`
	Text      string `json:"text"`
}

type ParsedDocumentContent struct {
	Text     string          `json:"text"`
	Sections []ParsedSection `json:"sections"`
}

type ParsedDocument struct {
	DocumentID string                `json:"documentId"`
	Title      string                `json:"title"`
	MimeType   string                `json:"mimeType"`
	Language   string                `json:"language,omitempty"`
	CharCount  int                   `json:"charCount"`
	PageCount  *int                  `json:"pageCount,omitempty"`
	Metadata   map[string]any        `json:"metadata,omitempty"`
	Content    ParsedDocumentContent `json:"content"`
}

type ParsedChunkMetadata struct {
	SectionPath []string `json:"sectionPath,omitempty"`
	StartOffset int      `json:"startOffset"`
	EndOffset   int      `json:"endOffset"`
	PageNumber  *int     `json:"pageNumber,omitempty"`
}

type ParsedChunk struct {
	ChunkID    string              `json:"chunkId"`
	DocumentID string              `json:"documentId"`
	ChunkIndex int                 `json:"chunkIndex"`
	Text       string              `json:"text"`
	CharCount  int                 `json:"charCount"`
	TokenCount *int                `json:"tokenCount,omitempty"`
	Metadata   ParsedChunkMetadata `json:"metadata"`
}

type EmbeddingInput struct {
	ChunkID      string              `json:"chunkId"`
	DocumentID   string              `json:"documentId"`
	ChunkIndex   int                 `json:"chunkIndex"`
	Text         string              `json:"text"`
	CharCount    int                 `json:"charCount"`
	ContentHash  string              `json:"contentHash"`
	Metadata     ParsedChunkMetadata `json:"metadata"`
	KnowledgeRef map[string]any      `json:"knowledgeRef,omitempty"`
}

type EmbeddingRequest struct {
	TraceID         string           `json:"traceId"`
	TaskID          string           `json:"taskId"`
	KnowledgeBaseID string           `json:"knowledgeBaseId"`
	DocumentID      string           `json:"documentId"`
	Model           string           `json:"model"`
	Inputs          []EmbeddingInput `json:"inputs"`
	Metadata        map[string]any   `json:"metadata,omitempty"`
}

type EmbeddingArtifact struct {
	ChunkID      string         `json:"chunkId"`
	Vector       []float32      `json:"vector,omitempty"`
	Dimensions   int            `json:"dimensions"`
	ContentHash  string         `json:"contentHash"`
	EmbeddingRef string         `json:"embeddingRef"`
	Source       string         `json:"source"`
	Metadata     map[string]any `json:"metadata,omitempty"`
}

type EmbeddingResult struct {
	Status       string              `json:"status"`
	Model        string              `json:"model"`
	Source       string              `json:"source"`
	VectorCount  int                 `json:"vectorCount"`
	Dimensions   int                 `json:"dimensions"`
	Artifacts    []EmbeddingArtifact `json:"artifacts,omitempty"`
	ErrorMessage string              `json:"errorMessage,omitempty"`
	Metadata     map[string]any      `json:"metadata,omitempty"`
}

type IndexRecord struct {
	RecordID        string         `json:"recordId"`
	KnowledgeBaseID string         `json:"knowledgeBaseId"`
	DocumentID      string         `json:"documentId"`
	ChunkID         string         `json:"chunkId"`
	ChunkIndex      int            `json:"chunkIndex"`
	Title           string         `json:"title"`
	Content         string         `json:"content"`
	EmbeddingRef    string         `json:"embeddingRef"`
	Vector          []float32      `json:"vector,omitempty"`
	Source          string         `json:"source"`
	Metadata        map[string]any `json:"metadata,omitempty"`
}

type IndexWriteRequest struct {
	TraceID         string         `json:"traceId"`
	TaskID          string         `json:"taskId"`
	KnowledgeBaseID string         `json:"knowledgeBaseId"`
	DocumentID      string         `json:"documentId"`
	IndexName       string         `json:"indexName"`
	Operation       string         `json:"operation,omitempty"`
	IdempotencyKey  string         `json:"idempotencyKey,omitempty"`
	Records         []IndexRecord  `json:"records"`
	Metadata        map[string]any `json:"metadata,omitempty"`
}

type IndexWriteResult struct {
	Status              string         `json:"status"`
	IndexName           string         `json:"indexName"`
	StoreType           string         `json:"storeType"`
	Source              string         `json:"source"`
	Operation           string         `json:"operation,omitempty"`
	RecordCount         int            `json:"recordCount"`
	IndexedChunkCount   int            `json:"indexedChunkCount"`
	SkippedRecordCount  int            `json:"skippedRecordCount,omitempty"`
	ReplacedRecordCount int            `json:"replacedRecordCount,omitempty"`
	DeletedRecordCount  int            `json:"deletedRecordCount,omitempty"`
	Records             []IndexRecord  `json:"records,omitempty"`
	ErrorMessage        string         `json:"errorMessage,omitempty"`
	Metadata            map[string]any `json:"metadata,omitempty"`
}

type ParserMetrics struct {
	ParseDurationMs int64 `json:"parseDurationMs"`
	ChunkDurationMs int64 `json:"chunkDurationMs"`
}

type ParserResult struct {
	ParserBackend  string          `json:"parserBackend,omitempty"`
	ParserName     string          `json:"parserName"`
	ParserVersion  string          `json:"parserVersion"`
	Status         string          `json:"status"`
	Warnings       []string        `json:"warnings,omitempty"`
	ParsedDocument *ParsedDocument `json:"parsedDocument,omitempty"`
	Chunks         []ParsedChunk   `json:"chunks,omitempty"`
	Metrics        ParserMetrics   `json:"metrics"`
	ErrorMessage   string          `json:"errorMessage,omitempty"`
}

type ProcessingTraceEvent struct {
	TraceID   string         `json:"traceId"`
	TaskID    string         `json:"taskId"`
	Stage     string         `json:"stage"`
	Level     string         `json:"level"`
	Status    string         `json:"status"`
	Message   string         `json:"message"`
	Timestamp string         `json:"timestamp"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

type IngestionTaskStatusResponse struct {
	TaskID           string                 `json:"taskId"`
	TraceID          string                 `json:"traceId"`
	KnowledgeBaseID  string                 `json:"knowledgeBaseId"`
	DocumentID       string                 `json:"documentId"`
	RequestedBy      string                 `json:"requestedBy"`
	Source           IngestionSource        `json:"source"`
	Status           string                 `json:"status"`
	CurrentStage     string                 `json:"currentStage"`
	AttemptCount     int                    `json:"attemptCount"`
	MaxAttempts      int                    `json:"maxAttempts,omitempty"`
	Retryable        bool                   `json:"retryable,omitempty"`
	NextRunAt        string                 `json:"nextRunAt,omitempty"`
	RetryAfterSec    int                    `json:"retryAfterSec,omitempty"`
	FailureReason    string                 `json:"failureReason,omitempty"`
	FailureStage     string                 `json:"failureStage,omitempty"`
	CreatedAt        string                 `json:"createdAt"`
	UpdatedAt        string                 `json:"updatedAt"`
	StartedAt        string                 `json:"startedAt,omitempty"`
	FinishedAt       string                 `json:"finishedAt,omitempty"`
	ErrorMessage     string                 `json:"errorMessage,omitempty"`
	ExecutionPlan    IngestionExecutionPlan `json:"executionPlan"`
	ParserResult     *ParserResult          `json:"parserResult,omitempty"`
	EmbeddingResult  *EmbeddingResult       `json:"embeddingResult,omitempty"`
	IndexWriteResult *IndexWriteResult      `json:"indexWriteResult,omitempty"`
	Chunks           []ParsedChunk          `json:"chunks,omitempty"`
	Trace            []ProcessingTraceEvent `json:"trace,omitempty"`
	Metadata         map[string]any         `json:"metadata,omitempty"`
}
