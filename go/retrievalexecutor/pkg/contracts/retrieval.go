package contracts

type RetrievalSearchRequest struct {
	TraceID          string         `json:"traceId"`
	Query            string         `json:"query"`
	ConversationID   string         `json:"conversationId,omitempty"`
	UserID           string         `json:"userId,omitempty"`
	TenantID         string         `json:"tenantId,omitempty"`
	OrgID            string         `json:"orgId,omitempty"`
	KnowledgeBaseIDs []string       `json:"knowledgeBaseIds,omitempty"`
	TopK             int            `json:"topK,omitempty"`
	Filters          map[string]any `json:"filters,omitempty"`
}

type RetrievalChunk struct {
	ChunkID         string         `json:"chunkId"`
	KnowledgeBaseID string         `json:"knowledgeBaseId"`
	DocumentID      string         `json:"documentId"`
	Title           string         `json:"title"`
	Content         string         `json:"content"`
	Score           float64        `json:"score"`
	Source          string         `json:"source"`
	Metadata        map[string]any `json:"metadata,omitempty"`
}

type RetrievalTiming struct {
	TotalMs int64 `json:"totalMs"`
}

type RetrievalSearchResponse struct {
	TraceID   string           `json:"traceId"`
	Chunks    []RetrievalChunk `json:"chunks"`
	Total     int              `json:"total"`
	LatencyMs int64            `json:"latencyMs"`
	Timing    RetrievalTiming  `json:"timing"`
	Source    string           `json:"source"`
}

type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	TraceID string `json:"traceId,omitempty"`
}
