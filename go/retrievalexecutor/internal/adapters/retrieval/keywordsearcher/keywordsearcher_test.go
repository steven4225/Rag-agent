package keywordsearcher

import (
	"math"
	"testing"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/retrieval"
)

func TestTokenizeEnglish(t *testing.T) {
	terms := Tokenize("the quick brown fox jumps over the lazy dog")
	if len(terms) == 0 {
		t.Fatal("expected non-empty terms for english text")
	}
	// "the" is 3 chars, should be included
	hasQuick := false
	for _, term := range terms {
		if term == "quick" {
			hasQuick = true
			break
		}
	}
	if !hasQuick {
		t.Errorf("expected 'quick' in terms, got %v", terms)
	}
}

func TestTokenizeChineseBigram(t *testing.T) {
	terms := Tokenize("请假流程")
	if len(terms) < 2 {
		t.Fatalf("expected at least bigrams, got %v", terms)
	}
	hasBigram := false
	for _, term := range terms {
		if term == "请假" {
			hasBigram = true
			break
		}
	}
	if !hasBigram {
		t.Errorf("expected bigram '请假' in terms, got %v", terms)
	}
}

func TestTokenizeMixed(t *testing.T) {
	terms := Tokenize("请假 policy 流程")
	foundCN := false
	foundEN := false
	for _, term := range terms {
		if term == "请假" || term == "流程" {
			foundCN = true
		}
		if term == "policy" {
			foundEN = true
		}
	}
	if !foundCN || !foundEN {
		t.Errorf("expected both Chinese bigrams and English terms, got %v", terms)
	}
}

func TestTokenizeEmpty(t *testing.T) {
	terms := Tokenize("")
	if len(terms) != 0 {
		t.Errorf("expected empty result, got %v", terms)
	}
}

func TestBM25ScoreBasic(t *testing.T) {
	queryTerms := []string{"hello", "world"}
	docTerms := []string{"hello", "world", "foo", "bar"}
	docFreq := map[string]int{"hello": 1, "world": 1, "foo": 1, "bar": 1}
	totalDocs := 1
	avgLen := 4.0
	params := DefaultBM25Params()

	score := BM25Score(queryTerms, docTerms, totalDocs, docFreq, avgLen, params)
	if score <= 0 {
		t.Errorf("expected positive score, got %f", score)
	}
}

func TestBM25ScoreNoMatch(t *testing.T) {
	queryTerms := []string{"missing"}
	docTerms := []string{"hello", "world"}
	docFreq := map[string]int{"hello": 1, "world": 1}
	totalDocs := 1
	avgLen := 2.0
	params := DefaultBM25Params()

	score := BM25Score(queryTerms, docTerms, totalDocs, docFreq, avgLen, params)
	if score != 0 {
		t.Errorf("expected zero score for no match, got %f", score)
	}
}

func TestBM25HigherForRarerTerm(t *testing.T) {
	queryTerms := []string{"rare"}
	docTermsRare := []string{"rare"}
	docTermsCommon := []string{"common"}

	// "rare" appears in 1 of 100 docs, "common" in 99 of 100
	docFreq := map[string]int{"rare": 1, "common": 99}
	totalDocs := 100
	avgLen := 1.0
	params := DefaultBM25Params()

	rareScore := BM25Score(queryTerms, docTermsRare, totalDocs, docFreq, avgLen, params)
	queryTermsCommon := []string{"common"}
	commonScore := BM25Score(queryTermsCommon, docTermsCommon, totalDocs, docFreq, avgLen, params)

	if rareScore <= commonScore {
		t.Errorf("rarer term should score higher: rare=%f common=%f", rareScore, commonScore)
	}
}

func TestBM25LengthPenalty(t *testing.T) {
	queryTerms := []string{"hi"}
	shortDoc := []string{"hi"}
	longDoc := []string{"hi", "a", "b", "c", "d", "e", "f", "g", "h", "i"}

	docFreq := map[string]int{"hi": 2}
	totalDocs := 2
	avgLen := 5.5
	params := DefaultBM25Params()

	shortScore := BM25Score(queryTerms, shortDoc, totalDocs, docFreq, avgLen, params)
	longScore := BM25Score(queryTerms, longDoc, totalDocs, docFreq, avgLen, params)

	if shortScore <= longScore {
		t.Errorf("shorter doc should score higher: short=%f long=%f", shortScore, longScore)
	}
}

func TestIDF(t *testing.T) {
	score := idf("rare", 100, map[string]int{"rare": 1})
	if score <= 0 {
		t.Errorf("expected positive IDF, got %f", score)
	}

	scoreCommon := idf("common", 100, map[string]int{"common": 100})
	if scoreCommon >= 0.05 {
		t.Errorf("term in all docs should have near-zero IDF, got %f", scoreCommon)
	}
}

func TestTFSaturation(t *testing.T) {
	// TF saturation: 1 occ vs 20 occ should not be 20x the score
	queryTerms := []string{"word"}
	oneDoc := []string{"word"}
	manyDoc := make([]string, 50)
	for i := range manyDoc {
		manyDoc[i] = "word"
	}

	docFreq := map[string]int{"word": 2}
	totalDocs := 2
	avgLen := 25.5
	params := DefaultBM25Params()

	oneScore := BM25Score(queryTerms, oneDoc, totalDocs, docFreq, avgLen, params)
	manyScore := BM25Score(queryTerms, manyDoc, totalDocs, docFreq, avgLen, params)

	// 50 occurrences should NOT give 50x the score of 1 occurrence
	ratio := manyScore / oneScore
	if ratio > 8 {
		t.Errorf("TF saturation not working: 50x occurs gave %.1fx the score of 1x occur", ratio)
	}
}

func TestSearcherBasic(t *testing.T) {
	chunks := []retrieval.Chunk{
		{ChunkID: "1", Title: "休假政策", Content: "员工每年享有10天带薪年假，需提前一周申请。"},
		{ChunkID: "2", Title: "打卡规则", Content: "员工需在9点前打卡，迟到需填写异常说明。"},
		{ChunkID: "3", Title: "薪资发放", Content: "每月15号发放上月工资，如遇节假日提前。"},
	}

	s := NewSearcher()
	s.BuildIndex(chunks)

	results := s.Search("请假流程怎么走")
	if len(results) == 0 {
		t.Fatal("expected results for leave query")
	}

	// Chunk 1 (休假) should be top result because it's about leave
	if results[0].ChunkID != "1" {
		t.Errorf("expected chunk 1 (leave policy) to rank first, got chunk %s with score %.4f",
			results[0].ChunkID, results[0].Score)
	}

	// Verify scores are positive
	for _, r := range results {
		if r.Score <= 0 {
			t.Errorf("chunk %s has non-positive score: %f", r.ChunkID, r.Score)
		}
	}
}

func TestSearcherEmptyIndex(t *testing.T) {
	s := NewSearcher()
	results := s.Search("anything")
	if len(results) != 0 {
		t.Errorf("expected no results from empty index, got %d", len(results))
	}
}

func TestSearcherKeywordBoost(t *testing.T) {
	// Two chunks with similar content but different titles.
	// The one with the keyword in the title should rank higher.
	chunks := []retrieval.Chunk{
		{ChunkID: "a", Title: "通用规范", Content: "关于休假申请流程的详细说明和步骤。"},
		{ChunkID: "b", Title: "休假申请流程指南", Content: "关于休假申请流程的详细说明和步骤。"},
	}

	s := NewSearcher()
	s.BuildIndex(chunks)
	results := s.Search("休假申请")

	if len(results) < 2 {
		t.Fatal("expected at least 2 results")
	}

	// Chunk b has matching title, should rank higher
	if results[0].ChunkID != "b" {
		t.Errorf("chunk with keyword in title should rank first: got chunk %s (score %.4f) vs chunk %s (score %.4f)",
			results[0].ChunkID, results[0].Score, results[1].ChunkID, results[1].Score)
	}
}

func TestDefaultBM25Params(t *testing.T) {
	p := DefaultBM25Params()
	if p.K1 != defaultK1 {
		t.Errorf("expected K1=%f, got %f", defaultK1, p.K1)
	}
	if p.B != defaultB {
		t.Errorf("expected B=%f, got %f", defaultB, p.B)
	}
}

func TestAvgDocLength(t *testing.T) {
	docs := [][]string{
		{"a", "b", "c"},
		{"d", "e"},
	}
	avg := avgDocLength(docs)
	expected := 2.5
	if math.Abs(avg-expected) > 0.001 {
		t.Errorf("expected avg=%f, got %f", expected, avg)
	}
}

func TestBuildDocFreq(t *testing.T) {
	docs := [][]string{
		{"a", "b"},
		{"b", "c"},
	}
	df := buildDocFreq(docs)
	if df["a"] != 1 || df["b"] != 2 || df["c"] != 1 {
		t.Errorf("unexpected doc freq: %v", df)
	}
}
