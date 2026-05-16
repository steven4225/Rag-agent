package keywordsearcher

import (
	"strings"
	"sync"
	"unicode"

	"github.com/go-ego/gse"
)

var (
	seg   gse.Segmenter
	segMu sync.Mutex
	segOK bool
)

func initSeg() {
	if segOK {
		return
	}
	segMu.Lock()
	defer segMu.Unlock()
	if segOK {
		return
	}
	// gse.New loads the embedded simplified Chinese dictionary.
	s, err := gse.New("zh")
	if err != nil {
		return
	}
	seg = s
	segOK = true
}

func isCJK(r rune) bool {
	return (r >= 0x4E00 && r <= 0x9FFF) ||
		(r >= 0x3400 && r <= 0x4DBF) ||
		(r >= 0xF900 && r <= 0xFAFF)
}

func isWordChar(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r)
}

// Tokenize splits text into terms for BM25 indexing and querying.
// Uses gse dictionary-based segmentation for precision, plus CJK bigrams
// for recall — the combination is the standard Chinese IR approach
// (equivalent to Elasticsearch ik_max_word = dictionary + bigram).
func Tokenize(text string) []string {
	text = strings.TrimSpace(strings.ToLower(text))
	if text == "" {
		return nil
	}

	initSeg()

	seen := make(map[string]struct{})

	// Precision: dictionary-based segmentation (gse search mode).
	if segOK {
		for _, w := range seg.Cut(text, true) {
			if w = strings.TrimSpace(w); w != "" {
				seen[w] = struct{}{}
			}
		}
	}

	// Recall: CJK unigram + bigram, Latin whitespace tokens.
	// This ensures related terms share common sub-tokens even when
	// the dictionary segments them differently (e.g. 请假 vs 休假
	// share no dictionary word, but 假 appears in both via unigram).
	runes := []rune(text)
	i := 0
	for i < len(runes) {
		if isCJK(runes[i]) {
			j := i
			for j < len(runes) && isCJK(runes[j]) {
				j++
			}
			block := runes[i:j]
			for k := 0; k < len(block); k++ {
				seen[string(block[k:k+1])] = struct{}{}
			}
			for k := 0; k < len(block)-1; k++ {
				seen[string(block[k:k+2])] = struct{}{}
			}
			if len(block) >= 3 {
				seen[string(block)] = struct{}{}
			}
			i = j
		} else if isWordChar(runes[i]) {
			j := i
			for j < len(runes) && isWordChar(runes[j]) {
				j++
			}
			term := string(runes[i:j])
			if len(term) >= 2 {
				seen[term] = struct{}{}
			}
			i = j
		} else {
			i++
		}
	}

	result := make([]string, 0, len(seen))
	for t := range seen {
		result = append(result, t)
	}
	return result
}
