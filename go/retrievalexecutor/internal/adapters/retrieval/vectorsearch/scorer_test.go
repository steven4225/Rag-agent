package vectorsearch

import (
	"errors"
	"math"
	"testing"
)

func TestCosineSimilarity(t *testing.T) {
	score, err := CosineSimilarity([]float32{1, 0}, []float32{1, 0})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if math.Abs(score-1.0) > 1e-9 {
		t.Fatalf("expected score 1, got %f", score)
	}
}

func TestCosineSimilarityDimensionMismatch(t *testing.T) {
	_, err := CosineSimilarity([]float32{1, 0}, []float32{1})
	if !errors.Is(err, ErrDimensionMismatch) {
		t.Fatalf("expected ErrDimensionMismatch, got %v", err)
	}
}

func TestCosineSimilarityZeroNorm(t *testing.T) {
	score, err := CosineSimilarity([]float32{0, 0}, []float32{1, 2})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if score != 0 {
		t.Fatalf("expected zero score for zero norm vector, got %f", score)
	}
}
