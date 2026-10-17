"""
Resolver response cache - the main cost-optimization lever in the pipeline.

Every ticket that reaches the Resolver Agent normally costs one flagship-
model call (and, since the agentic-tools change, sometimes several more on
top of that). Support tickets cluster heavily around a small set of real
issues - camera, password reset, VPN, connectivity - so most tickets are not
actually new problems, just new wording for one already seen.

This cache is keyed on the *top RAG citation id*, not the raw issue text.
That's the important design choice: "my camera won't turn on" and "camera
is not working" are different strings but both retrieve the same KB
document via vector search, so keying on the citation id gets semantic-level
cache hits without adding any fuzzy-matching or embedding logic here - it
reuses a signal the pipeline already computes for free.

Deliberately in-memory, not Cosmos-backed: this is a cost-saving optimization,
so it shouldn't itself add Cosmos read/write cost. The trade-off is the cache
resets on redeploy/restart and isn't shared across replicas if the Container
App ever scales beyond one instance - both fine for this system's actual
scale, and easy to swap for a Cosmos-backed version later if that changes.

Guardrail note: a cache hit only ever skips the Resolver's drafting call.
The Critic Agent still reviews every single ticket, cached or not - caching
the draft is not the same as caching the decision to auto-resolve.
"""
import time
from collections import OrderedDict, deque
from typing import Optional

from config import settings

# citation_id -> {"resolution_text": str, "confidence": float,
#                  "proposed_action": str, "cached_at": float}
# OrderedDict so we can evict the oldest entry once RESOLVER_CACHE_MAX_ENTRIES
# is hit, without pulling in a separate LRU dependency.
_cache: "OrderedDict[str, dict]" = OrderedDict()

# Live counters for the Admin Dashboard's cache-memory panel. In-memory only,
# same lifetime as _cache itself (resets on redeploy/restart) - this is a
# demo/teaching instrument, not a durable metric, so no Cosmos write cost
# gets added just to track it.
_hits = 0
_misses = 0
_expired = 0
_recent: "deque[dict]" = deque(maxlen=25)  # most recent cache events, newest first


def _record(event: str, citation_id: Optional[str]) -> None:
    _recent.appendleft({"event": event, "citation_id": citation_id, "at": time.time()})


def _is_expired(entry: dict) -> bool:
    return (time.time() - entry["cached_at"]) > settings.RESOLVER_CACHE_TTL_SECONDS


def get(citation_id: Optional[str], rag_confidence: Optional[float]) -> Optional[dict]:
    """Returns a cached Resolver result if this citation has been resolved
    before, the RAG match was strong enough (for both the cached answer and
    the current ticket) to trust reusing it, and the entry hasn't expired.
    Returns None on any miss - callers should treat that as "run the LLM"."""
    global _hits, _misses, _expired

    if not settings.RESOLVER_CACHE_ENABLED or not citation_id:
        _misses += 1
        _record("miss", citation_id)
        return None
    if (rag_confidence or 0.0) < settings.RESOLVER_CACHE_MIN_RAG_CONFIDENCE:
        _misses += 1
        _record("miss_low_confidence", citation_id)
        return None

    entry = _cache.get(citation_id)
    if entry is None:
        _misses += 1
        _record("miss", citation_id)
        return None
    if _is_expired(entry):
        del _cache[citation_id]
        _expired += 1
        _misses += 1
        _record("expired", citation_id)
        return None

    _cache.move_to_end(citation_id)  # mark as recently used
    _hits += 1
    _record("hit", citation_id)
    return entry


def set(citation_id: Optional[str], resolution_text: str, confidence: float, proposed_action: str) -> None:
    """Stores a Resolver result for reuse. Only ever called with high-
    confidence results (see resolver_agent.py) - a shaky first answer for an
    edge case should never get replayed on every future match."""
    if not settings.RESOLVER_CACHE_ENABLED or not citation_id:
        return

    _cache[citation_id] = {
        "resolution_text": resolution_text,
        "confidence": confidence,
        "proposed_action": proposed_action,
        "cached_at": time.time(),
    }
    _cache.move_to_end(citation_id)

    while len(_cache) > settings.RESOLVER_CACHE_MAX_ENTRIES:
        _cache.popitem(last=False)  # evict oldest


def stats() -> dict:
    """Exposed for the Admin Dashboard's cache-memory panel / a quick sanity
    check - not required for the cache to function. hit_rate_pct is computed
    from real hits/misses since process start, not a fabricated number."""
    total = _hits + _misses
    return {
        "enabled": settings.RESOLVER_CACHE_ENABLED,
        "entries": len(_cache),
        "max_entries": settings.RESOLVER_CACHE_MAX_ENTRIES,
        "ttl_seconds": settings.RESOLVER_CACHE_TTL_SECONDS,
        "min_rag_confidence": settings.RESOLVER_CACHE_MIN_RAG_CONFIDENCE,
        "hits": _hits,
        "misses": _misses,
        "expired": _expired,
        "hit_rate_pct": round((_hits / total) * 100, 1) if total else 0.0,
        "recent_events": list(_recent),
    }
