"""
Question-level cache - skips the Intake and Triage LLM calls for a question
that has already been through the pipeline and ended in a clean auto-resolve.

What it stores is only the CLASSIFICATION those two agents produce (category
and request_type), keyed on the normalized question text. It does not store
an answer. On a hit the pipeline still runs RAG, the Resolver (which has its
own resolution cache) and the Critic, so every guardrail and every human-
review rule runs exactly as it does for a new question.

Safety rule: an entry is written ONLY when the finished ticket
  - was auto-resolved by the Critic (no human review needed),
  - carried no guardrail flags at all, and
  - matched a knowledge-base article tagged "auto_resolve".
So a 2FA reset, an admin-access request, a data-loss crash or a low-confidence
ticket can never enter this cache, and a hit can never route around review.

In-memory by design, same trade-off as resolution_cache.py: no extra Cosmos
cost, but it empties on restart and is not shared across replicas. Matching is
exact on normalized text (lowercase, punctuation stripped, whitespace
collapsed), so "camera issues" and "Camera issues?" share an entry but a
reworded question does not - rewording is still caught by the resolution cache.
"""
import re
import time
from collections import OrderedDict, deque
from typing import Optional

from config import settings

# normalized question -> {"category": str, "request_type": str, "cached_at": float}
_cache: "OrderedDict[str, dict]" = OrderedDict()

_hits = 0
_misses = 0
_expired = 0
_recent: "deque[dict]" = deque(maxlen=25)  # newest first


def _normalize(text: str) -> str:
    text = (text or "").lower()
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _record(event: str, key: str) -> None:
    _recent.appendleft({"event": event, "question": key[:80], "at": time.time()})


def get(question: str) -> Optional[dict]:
    """Returns the cached classification for this question, or None."""
    global _hits, _misses, _expired
    if not settings.QUESTION_CACHE_ENABLED:
        return None

    key = _normalize(question)
    entry = _cache.get(key) if key else None
    if entry is None:
        _misses += 1
        _record("miss", key)
        return None
    if (time.time() - entry["cached_at"]) > settings.QUESTION_CACHE_TTL_SECONDS:
        del _cache[key]
        _expired += 1
        _misses += 1
        _record("expired", key)
        return None

    _cache.move_to_end(key)
    _hits += 1
    _record("hit", key)
    return entry


def maybe_store(state) -> bool:
    """Called right after the Critic. Stores the question's classification only
    if the ticket meets the safety rule in the module docstring. Returns True
    if an entry was written."""
    if not settings.QUESTION_CACHE_ENABLED:
        return False
    if state.status != "auto_resolved" or state.guardrail_flags:
        return False
    top_tag = state.rag_citations[0].get("confidence_tag") if state.rag_citations else None
    if top_tag != "auto_resolve":
        return False
    if not state.category or not state.request_type:
        return False

    key = _normalize(state.issue_text)
    if not key:
        return False
    existing = _cache.get(key)
    if existing and (time.time() - existing["cached_at"]) <= settings.QUESTION_CACHE_TTL_SECONDS:
        return False  # already cached and fresh - don't extend its life

    _cache[key] = {"category": state.category, "request_type": state.request_type, "cached_at": time.time()}
    _cache.move_to_end(key)
    _record("stored", key)
    while len(_cache) > settings.QUESTION_CACHE_MAX_ENTRIES:
        _cache.popitem(last=False)
    return True


def stats() -> dict:
    total = _hits + _misses
    return {
        "enabled": settings.QUESTION_CACHE_ENABLED,
        "entries": len(_cache),
        "max_entries": settings.QUESTION_CACHE_MAX_ENTRIES,
        "ttl_seconds": settings.QUESTION_CACHE_TTL_SECONDS,
        "hits": _hits,
        "misses": _misses,
        "expired": _expired,
        "hit_rate_pct": round((_hits / total) * 100, 1) if total else 0.0,
        "recent_events": list(_recent),
    }
