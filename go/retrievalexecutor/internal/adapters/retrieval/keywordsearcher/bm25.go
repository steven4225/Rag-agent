package keywordsearcher

import "math"

const (
	defaultK1 = 1.5
	defaultB  = 0.75
)

type BM25Params struct {
	K1 float64
	B  float64
}

func DefaultBM25Params() BM25Params {
	return BM25Params{K1: defaultK1, B: defaultB}
}

// BM25Score computes the BM25 score for a single document given a query.
//
//	Score(d, q) = Σ IDF(term) × (tf × (k1 + 1)) / (tf + k1 × (1 − b + b × dl / avgdl))
func BM25Score(
	queryTerms []string,
	docTerms []string,
	totalDocs int,
	docFreq map[string]int,
	avgDocLen float64,
	params BM25Params,
) float64 {
	dl := float64(len(docTerms))
	termFreq := termFrequency(docTerms)

	var score float64
	seen := map[string]bool{}
	for _, term := range queryTerms {
		if seen[term] {
			continue
		}
		seen[term] = true

		idf := idf(term, totalDocs, docFreq)
		if idf == 0 {
			continue
		}

		tf := float64(termFreq[term])
		if tf == 0 {
			continue
		}

		numerator := tf * (params.K1 + 1)
		if avgDocLen == 0 {
			continue
		}
		denominator := tf + params.K1*(1-params.B+params.B*dl/avgDocLen)
		score += idf * numerator / denominator
	}

	return score
}

// idf computes inverse document frequency.
// IDF(term) = log((N − df + 0.5) / (df + 0.5) + 1)
func idf(term string, totalDocs int, docFreq map[string]int) float64 {
	df := docFreq[term]
	if df == 0 {
		return 0
	}
	return math.Log((float64(totalDocs)-float64(df)+0.5)/(float64(df)+0.5) + 1)
}

func termFrequency(terms []string) map[string]int {
	freq := make(map[string]int, len(terms))
	for _, term := range terms {
		freq[term]++
	}
	return freq
}

// avgDocLength computes average document length (in tokens) across all docs.
func avgDocLength(docTokens [][]string) float64 {
	if len(docTokens) == 0 {
		return 0
	}
	var total int
	for _, tokens := range docTokens {
		total += len(tokens)
	}
	return float64(total) / float64(len(docTokens))
}

// buildDocFreq counts how many documents contain each term.
func buildDocFreq(docTokens [][]string) map[string]int {
	df := make(map[string]int)
	for _, tokens := range docTokens {
		seen := map[string]bool{}
		for _, term := range tokens {
			if !seen[term] {
				df[term]++
				seen[term] = true
			}
		}
	}
	return df
}
