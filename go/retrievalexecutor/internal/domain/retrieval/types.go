package retrieval

import "context"

const (
	DefaultTopK          = 6
	MaxTopK              = 20
	SourceLocalCorpus    = "local-corpus"
	SourceIndexedStore   = "indexed-store"
	SourceSelectionError = "retrieval-source-selection-error"
	RetrievalModeKeyword = "keyword"
	RetrievalModeVector  = "vector"
	RetrievalModeHybrid  = "hybrid"
	ScoreSourceKeyword   = "keyword"
	ScoreSourceVector    = "vector"
	ScoreSourceHybrid    = "hybrid"
)

type SearchInput struct {
	TraceID          string
	Query            string
	ConversationID   string
	UserID           string
	TenantID         string
	OrgID            string
	KnowledgeBaseIDs []string
	TopK             int
	Filters          map[string]any
}

type Chunk struct {
	ChunkID         string
	KnowledgeBaseID string
	DocumentID      string
	Title           string
	Content         string
	Score           float64
	Source          string
	Metadata        map[string]any
}

type SearchResult struct {
	TraceID   string
	Chunks    []Chunk
	Total     int
	LatencyMs int64
	Source    string
}

type SourceResult struct {
	Chunks []Chunk
	Total  int
}

type Source interface {
	Name() string
	Search(ctx context.Context, input SearchInput) (SourceResult, error)
}

type Executor interface {
	Search(ctx context.Context, input SearchInput) (SearchResult, error)
}

type VectorStoreAdapter interface {
	Search(ctx context.Context, input SearchInput) ([]Chunk, error)
}

type RerankAdapter interface {
	Rerank(ctx context.Context, query string, chunks []Chunk, topK int) ([]Chunk, error)
}

type MetadataFilter interface {
	Apply(chunks []Chunk, filters map[string]any) ([]Chunk, error)
}
