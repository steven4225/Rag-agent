package vectorsearch

import (
	"errors"
	"math"
)

var ErrDimensionMismatch = errors.New("vector dimensions mismatch")

func CosineSimilarity(query []float32, candidate []float32) (float64, error) {
	if len(query) == 0 || len(candidate) == 0 {
		return 0, ErrDimensionMismatch
	}
	if len(query) != len(candidate) {
		return 0, ErrDimensionMismatch
	}

	dot := 0.0
	queryNorm := 0.0
	candidateNorm := 0.0
	for index := range query {
		q := float64(query[index])
		c := float64(candidate[index])
		dot += q * c
		queryNorm += q * q
		candidateNorm += c * c
	}

	if queryNorm == 0 || candidateNorm == 0 {
		return 0, nil
	}

	return dot / (math.Sqrt(queryNorm) * math.Sqrt(candidateNorm)), nil
}
