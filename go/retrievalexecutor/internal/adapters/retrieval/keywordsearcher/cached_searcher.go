package keywordsearcher

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"sync/atomic"

	"github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/retrieval"
)

const defaultMaxCacheEntries = 128

type CacheStats struct {
	Hits     int64 `json:"hits"`
	Misses   int64 `json:"misses"`
	Entries  int   `json:"entries"`
	MaxSize  int   `json:"maxSize"`
	Evictions int64 `json:"evictions"`
}

// CachedSearcher wraps a Searcher with an in-memory cache keyed by chunk identity.
// The index is rebuilt only when the chunk set changes.
type CachedSearcher struct {
	mu        sync.RWMutex
	cache     map[string]*Searcher
	maxSize   int
	hits      atomic.Int64
	misses    atomic.Int64
	evictions atomic.Int64
}

func NewCachedSearcher() *CachedSearcher {
	return &CachedSearcher{
		cache:   make(map[string]*Searcher),
		maxSize: defaultMaxCacheEntries,
	}
}

func (cs *CachedSearcher) Search(chunks []retrieval.Chunk, query string) ([]retrieval.Chunk, error) {
	key := searcherCacheKey(chunks)
	cs.mu.RLock()
	searcher, ok := cs.cache[key]
	cs.mu.RUnlock()
	if ok {
		cs.hits.Add(1)
		return searcher.Search(query), nil
	}
	cs.misses.Add(1)
	cs.mu.Lock()
	searcher, ok = cs.cache[key]
	if !ok {
		if len(cs.cache) >= cs.maxSize {
			cs.evictions.Add(1)
			cs.cache = make(map[string]*Searcher, cs.maxSize)
		}
		searcher = NewSearcher()
		searcher.BuildIndex(chunks)
		cs.cache[key] = searcher
	}
	cs.mu.Unlock()
	return searcher.Search(query), nil
}

func (cs *CachedSearcher) Stats() CacheStats {
	cs.mu.RLock()
	entries := len(cs.cache)
	cs.mu.RUnlock()
	return CacheStats{
		Hits:     cs.hits.Load(),
		Misses:   cs.misses.Load(),
		Entries:  entries,
		MaxSize:  cs.maxSize,
		Evictions: cs.evictions.Load(),
	}
}

func searcherCacheKey(chunks []retrieval.Chunk) string {
	if len(chunks) == 0 {
		return "empty"
	}
	h := sha256.New()
	for _, c := range chunks {
		h.Write([]byte(c.ChunkID))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}
