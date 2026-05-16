package qdrant

import "encoding/json"

type collectionsResponse struct {
	Status string          `json:"status"`
	Result json.RawMessage `json:"result"`
}

type collectionInfoResponse struct {
	Status string          `json:"status"`
	Result json.RawMessage `json:"result"`
}

type upsertRequest struct {
	Points []point `json:"points"`
}

// point uses named vectors: "dense" for float32 embeddings and "sparse"
// for term-frequency sparse vectors. Qdrant fuses both internally via RRF
// when the search request includes both vector types.
type point struct {
	ID      uint64         `json:"id"`
	Vector  map[string]any `json:"vector"`
	Payload map[string]any `json:"payload,omitempty"`
}

type qdrantSparseVector struct {
	Indices []int     `json:"indices"`
	Values  []float32 `json:"values"`
}

type upsertResponse struct {
	Status string `json:"status"`
}

// searchRequest supports optional sparse vector for native hybrid search.
// When both vector and sparse_vector are set, Qdrant fuses results with RRF.
type searchRequest struct {
	Vector       []float32           `json:"vector"`
	SparseVector *qdrantSparseVector `json:"sparse_vector,omitempty"`
	Limit        int                 `json:"limit"`
	Filter       map[string]any      `json:"filter,omitempty"`
	Params       map[string]any      `json:"params,omitempty"`
	WithPayload  bool                `json:"with_payload"`
	WithVector   bool                `json:"with_vector"`
}

type searchResponse struct {
	Status string        `json:"status"`
	Result []searchPoint `json:"result"`
}

// searchPoint handles both anonymous vectors (legacy) and named vectors (dense+sparse).
type searchPoint struct {
	ID      any            `json:"id"`
	Score   float64        `json:"score"`
	Payload map[string]any `json:"payload"`
	Vector  any            `json:"vector"`
}

// denseVector extracts the dense float32 vector from a named-vector search hit.
func (sp searchPoint) denseVector() []float32 {
	switch v := sp.Vector.(type) {
	case []any:
		result := make([]float32, len(v))
		for i, val := range v {
			if f, ok := val.(float64); ok {
				result[i] = float32(f)
			}
		}
		return result
	case map[string]any:
		if dense, ok := v["dense"]; ok {
			switch arr := dense.(type) {
			case []any:
				result := make([]float32, len(arr))
				for i, val := range arr {
					if f, ok := val.(float64); ok {
						result[i] = float32(f)
					}
				}
				return result
			case []float32:
				return arr
			}
		}
	}
	return nil
}

type scrollRequest struct {
	Limit       int            `json:"limit"`
	Filter      map[string]any `json:"filter,omitempty"`
	WithPayload bool           `json:"with_payload"`
	WithVector  bool           `json:"with_vector"`
	Offset      any            `json:"offset,omitempty"`
}

type scrollResponse struct {
	Status string `json:"status"`
	Result struct {
		Points         []searchPoint `json:"points"`
		NextPageOffset any           `json:"next_page_offset"`
	} `json:"result"`
}

type countRequest struct {
	Filter map[string]any `json:"filter,omitempty"`
	Exact  bool           `json:"exact"`
}

type countResponse struct {
	Status string `json:"status"`
	Result struct {
		Count int `json:"count"`
	} `json:"result"`
}

type deleteRequest struct {
	Filter map[string]any `json:"filter"`
}

type deleteResponse struct {
	Status string `json:"status"`
}
