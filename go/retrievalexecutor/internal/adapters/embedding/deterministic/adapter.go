package deterministic

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/ingestion"
)

const (
	DefaultModel      = "mock-embedding-v1"
	DefaultDimensions = 8
	ProviderName      = "deterministic"
	SourceName        = "go-deterministic-embedding"
)

type Adapter struct {
	dimensions int
}

func NewAdapter() *Adapter {
	return &Adapter{dimensions: DefaultDimensions}
}

func (a *Adapter) Embed(_ context.Context, request ingestion.EmbeddingRequest) (ingestion.EmbeddingResult, error) {
	model := strings.TrimSpace(request.Model)
	if model == "" {
		model = DefaultModel
	}

	artifacts := make([]ingestion.EmbeddingArtifact, 0, len(request.Inputs))
	for _, input := range request.Inputs {
		vector, embeddingRef := deterministicVector(model, input)
		artifacts = append(artifacts, ingestion.EmbeddingArtifact{
			ChunkID:      input.ChunkID,
			Vector:       vector,
			Dimensions:   len(vector),
			ContentHash:  input.ContentHash,
			EmbeddingRef: embeddingRef,
			Source:       SourceName,
			Metadata: map[string]any{
				"chunkIndex": input.ChunkIndex,
				"adapter":    "deterministic-placeholder",
				"provider":   ProviderName,
			},
		})
	}

	return ingestion.EmbeddingResult{
		Status:      ingestion.StatusSucceeded,
		Model:       model,
		Source:      SourceName,
		VectorCount: len(artifacts),
		Dimensions:  a.dimensions,
		Artifacts:   artifacts,
		Metadata: map[string]any{
			"placeholder":       true,
			"inputCount":        len(request.Inputs),
			"embeddingProvider": ProviderName,
			"embeddingModel":    model,
			"vectorDimensions":  a.dimensions,
		},
	}, nil
}

func deterministicVector(model string, input ingestion.EmbeddingInput) ([]float32, string) {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%s|%s|%d", model, input.ChunkID, input.ContentHash, input.CharCount)))
	vector := make([]float32, 0, DefaultDimensions)
	for index := 0; index < DefaultDimensions; index++ {
		offset := index * 4
		value := uint32(sum[offset])<<24 | uint32(sum[offset+1])<<16 | uint32(sum[offset+2])<<8 | uint32(sum[offset+3])
		vector = append(vector, float32(value%10000)/10000)
	}
	return vector, hex.EncodeToString(sum[:12])
}
