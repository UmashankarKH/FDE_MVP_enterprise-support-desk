**Trainer:** Umashankar K H
**Client:** FDE Academy
**Program:** Agentic Core at Pro Depth — Session S1 of 9 (+ Capstone)

---

# 2-Hour Session Plan — "The Model as a Component: What It Costs to Run"
## Enterprise Support Desk Edition — S1 of a 3-week FDE Academy arc (see companion ToC doc)

**Track:** FDE Academy · Phase 1, Agentic Core at Pro Depth · S1
**Duration:** 120 minutes
**Audience:** Most advanced learners (assume they already know what an LLM/token is, prompt frameworks, and the GenAI tool landscape — do not re-teach this)

**Throughline case:** The **Enterprise Support & Ticket Resolution Agent** — a live multi-agent pipeline (Intake → Triage → Policy/RAG → Resolver → Critic → Action) already deployed on Azure Container Apps. This is the same system every session for the next 3 weeks will work against.

> **v3 change log:** Added a 15-minute context-setting call at the open and a 6-minute cost-at-scale preview after Segment C. Technical depth increased throughout — each segment now carries an "Instructor depth notes" block with the underlying formula, mechanism, or real system internal, for use if the room can absorb it without slowing the run sheet. Timing unchanged from v2 (still 120 minutes total).

---

## Learning outcome (say this out loud at minute 15)

By the end of today, every learner can:
1. Explain why output tokens cost more than input tokens, and why latency and cost split at prefill vs. decode — including which one continuous batching helps and which it can hurt.
2. Derive the KV-cache size formula on a whiteboard and identify which term each real-world mitigation (GQA, MQA, int8 quantization) shrinks.
3. Price the real Enterprise Support Desk workload from its actual price sheet, with and without the resolution cache, and state exactly which pipeline stage the cache does and doesn't skip.
4. Diagnose a cost or availability blowup from symptoms alone, including explaining *why* a backend crash can present as a browser-side CORS error (an ASGI middleware-ordering fact, not a coincidence).
5. Build a model-selection scorecard and audit a real decision this project already made against it.
6. Name what changes about cost optimization once you leave demo scale — full depth in S8.

Skip entirely: what an LLM is, what tokens are, prompt frameworks, the GenAI tool landscape, transformer history.

---

## Materials to have open/ready before the room starts

- The companion **3-Week Curriculum ToC doc**.
- `config.py`'s `TOKEN_PRICING` block, live — not a generic price sheet.
- A whiteboard or shared doc for the KV-cache derivation.
- The scorecard template, plus a read-only view of `config.py` and `resolution_cache.py`.
- A doc for pods to post their monthly budget number and scorecard row.

---

## Minute-by-minute run sheet

### 0. Context-setting call — 0:00–0:15 (15 min)
Walk the 3-week arc via the companion ToC doc (2-3 min/week, orientation only), introduce the Enterprise Support Desk as the fixed throughline for all 9 sessions, set format expectations (cold-calls, pods, a take-home and an artifact every session), land today's slice: "S1 — the model as a component, the foundation everything downstream assumes."

### A. Inference mechanics as cost drivers — 0:15–0:40 (25 min)

1. **Two phases of inference:** prefill (parallel, compute-bound, sets TTFT) vs. decode (sequential, memory-bandwidth-bound, sets TPS — every step re-reads the full KV cache).

   > **Instructor depth note:** Prefill throughput scales with available FLOPs; decode throughput scales with memory bandwidth divided by (KV cache size per token × concurrent sequences). This is why decode is the harder engineering problem at scale — you can't just add compute to fix it, you have to shrink the cache or the bandwidth demand.

2. **Batching's opposite effects, precisely:** batching helps prefill because it's an embarrassingly parallel matrix-multiply — more requests, same fixed overhead amortized. Batching hurts naive decode because every concurrent stream competes for the same memory bandwidth reading its own KV cache each step; continuous/in-flight batching schedulers (vLLM-style) mitigate this by admitting new requests into freed decode slots dynamically rather than batching statically, but don't eliminate the underlying bandwidth contention.

3. **Whiteboard the KV cache formula:**

   ```
   KV cache size = layers × 2 × heads × head_dim × bytes_per_param × sequence_length
   ```

   Walk each term's real-world lever: `2` (Keys + Values, structurally fixed); `heads` (shrunk by GQA — multiple query heads share one KV head — or MQA, the extreme single-KV-head case); `bytes_per_param` (shrunk by int8/int4 KV cache quantization); `sequence_length` (the term that makes long-context serving expensive — this is *per sequence*, multiply by concurrency for total memory footprint).

   > **Instructor depth note:** gpt-4o's exact layer/head counts aren't public — use a comparably-sized open-weight model (70B-class) for the concrete numbers, and say so out loud. The physics is identical regardless of whose weights are running.

   > **Project callback:** this is precisely why the Resolver (flagship, gpt-4o) costs meaningfully more per call than Intake/Triage (mini, gpt-4.1-mini) — a different, larger model behind the same API shape, with a heavier decode cost profile.

4. Depth check: cold-call one learner to explain why output tokens cost more than input, and why TTFT/TPS can diverge after an optimization.

### B. Case discussion — Character.AI serving stack — 0:40–0:45 (5 min)
Serving cost cut **≥33x** since 2022 via multi-query attention, cross-layer KV sharing, int8 quantization — the KV cache was the bottleneck, not raw compute.

Discussion prompt: *"This project is API-only against a hosted model — which of these levers do we actually control?"*

> **Answer:** caching (`resolution_cache.py`) and prompt shortening — not quantization or attention internals, since Azure owns the weights and serving stack. Batching is unused here — name it as an open lever, not a settled decision.

### C. Price sheet arithmetic — real numbers — 0:45–1:03 (18 min) *(protected)*
Pull up `config.py`'s `TOKEN_PRICING`:

> mini (gpt-4.1-mini): $0.0004/1K in, $0.0016/1K out. flagship (gpt-4o): $0.0025/1K in, $0.01/1K out — flagship ≈ **6x** mini per token.

Real pipeline: Intake (mini) → Triage (mini) → RAG lookup (embedding call, near-zero) → Resolver (flagship, up to 4 tool-calling rounds) → Critic (flagship) → Action (no LLM call, deterministic simulation — genuinely free).

> **Instructor depth note — why multi-round tool-calling compounds cost:** each additional Resolver tool-calling round resends the *entire growing conversation history* as fresh input tokens to the model — round 2's input includes round 1's full prompt plus its tool call plus its tool result. Cost per round doesn't stay flat; it grows with each round the agent decides to take. The cost tracer must sum `prompt_tokens`/`completion_tokens` across every real round, not just the final response, or it silently under-counts — a bug this project's own SK integration actually had until `history.add_message(response)` was added explicitly, since SK's internal auto-invoke loop never appends the terminal round to history on its own.

Worked example, clearly labeled assumed volume:
- 50,000 tickets/month. Token sizes from real SYSTEM_PROMPTs: Intake ~250 in/80 out; Triage ~180 in/60 out; Resolver ~450 in/180 out (single round); Critic ~350 in/100 out.
- No caching: mini ≈ $0.0004/ticket, flagship ≈ $0.0048/ticket, total ≈ **$0.0052/ticket** → **≈ $260/month**.
- With resolution cache (Resolver only — Critic still runs every ticket, guardrail preserved) at assumed 25% hit rate: ≈ **$36.50/month saved**, ~14% reduction.

> **Honesty note:** don't inflate the volume for drama — the % reduction and architectural discipline matter even when the raw number is modest.

### C+. Cost optimization at scale — preview, not the full session — 1:03–1:09 (6 min)
*"S8 owns the full depth. Three things to hold onto:"*
- Cost-driver identity shifts with scale — fixed-SKU Search infra (near-zero marginal cost here) becomes a dominant, sharding/replica-driven cost at web scale.
- A caching failure isn't a bug, it's a budget incident — cache-hit rate needs to be a monitored, alerted number at scale, not a log line.
- Tiering gains dimensions — one env var here; per-tenant/per-priority routing across more than two tiers at scale.

### D. Prompt caching mechanics — and why this project doesn't use provider-side caching — 1:09–1:21 (12 min)
Teach precisely: byte-identical prefix required (whitespace, ordering, anything variable breaks it silently), TTL expiry, write cost > normal call, read cost < normal call — most providers need ~1,024+ identical leading tokens before any hit is even possible.

> **Project callback:** this project's own system prompts (Intake ~250, Triage ~180, Critic ~350 tokens) sit well under that floor — native caching would net close to zero benefit here. `resolution_cache.py` instead keys an application-level response cache on the RAG citation id, not raw text — differently-worded tickets about the same issue ("camera won't turn on" vs. "camera not working") retrieve the same citation via vector search and can share a cached resolution, which prefix caching structurally cannot do.

**Case 2 (external, anonymized):** annual token budget burned in month one — corrupted caching layer silently re-sent the full prefix every call, no cost-per-request alert, nobody owned the budget.

> **This project's own version:** a missing Search index, then a deleted Cosmos DB account, each crashed the backend on startup — and the browser reported a **CORS error**, not the real cause.
>
> **Instructor depth note — why this happens, precisely:** Starlette's `CORSMiddleware` wraps the ASGI app and attaches `Access-Control-Allow-Origin` headers to *successful* responses passing back through it. When an unhandled exception occurs deep in the request-handling stack (e.g. `os.environ["COSMOS_ENDPOINT"]` raising `KeyError` at import time, or a DNS failure connecting to a deleted resource), the exception can propagate past the point where the middleware would normally attach headers, so the browser receives a response with no CORS headers at all — and reports "blocked by CORS policy" even though CORS was never the actual failure. The fix in both real cases here was never a CORS config change — it was reading `az containerapp logs show --follow` to find the real exception (`KeyError`, then `azure.core.exceptions.ServiceRequestError: Failed to resolve...`).

Discussion prompt: *"Given the real per-ticket cost from Segment C, what threshold would you actually set for a cost-per-request alert?"*

### E. Break — 1:21–1:26 (5 min)

### F. Model selection as a method — audited against a real decision — 1:26–1:40 (14 min)

| Dimension | How you measure it | What this project actually did |
|---|---|---|
| Capability | Your own 20-query test set | **Not built** — role-fit reasoning used instead. Name this gap. |
| Latency | p95, not mean | **Not formally measured.** Another honest gap. |
| Cost | Cost/1,000 requests, from real price-sheet arithmetic | **Real** — traced per call in `kernel_setup.py`, correctly summed across multi-round turns. |
| Reversibility | Two-way door, or lock-in? | **Genuinely two-way** — `MINI_DEPLOYMENT`/`FLAGSHIP_DEPLOYMENT` are env vars, proven live during a mid-build model deprecation. |

> **Cold-call answer from the real project:** a pinned `gpt-4o-mini` version hit "deprecating" mid-build and couldn't be redeployed. Fix: go to the live model catalog, pick a currently-deployable version, confirm cost tiering still held — a follow-up bug briefly had *both* tiers deployed as `gpt-4o`, silently erasing the mini/flagship cost split, caught only because tiering was being actively watched for, not assumed correct.

### G. Interview-question drill — 1:40–1:45 (5 min)
1. *"A client wants to switch off an expensive flagship model. How do you decide?"* Weak: leaderboards. Strong: real test set, p95 latency, cost/1,000, reversible two-way door framing.
2. *"You inherit a system throwing errors with no code change on your end. Where do you look first?"* Strong order: source logs directly → real exception class → what changed in the last deploy/infra edit → verify against a clean log. Lived twice on this system — same browser symptom (CORS), two unrelated root causes.

### H. Hands-on — price a real ticket three ways — 1:45–1:57 (12 min)
Pods price one real KB ticket three ways: fresh Resolver call, multi-turn conversation, resolution-cache hit (Critic still runs regardless). Each pod fills one scorecard row and posts a monthly budget number at their own assumed volume.

### I. Wrap-up + take-home — 1:57–2:00 (3 min)
*"You should now be able to price a real workload without a calculator, and explain what changes about that pricing once you leave demo scale."*

**Take-home:** audit this project's real model-tier choice against your scorecard method — pull real `TOKEN_PRICING` values, fill Capability/Latency honestly (not formally measured in the real build) — post before S2.

---

## Reference material

- Prefill vs. decode: https://redis.io/blog/prefill-vs-decode/
- Character.AI, *Optimizing AI Inference at Character.AI*: https://blog.character.ai/optimizing-ai-inference-at-character-ai/
- Anthropic, *Building effective agents* (augmented-LLM section only): https://www.anthropic.com/engineering/building-effective-agents
- This project's own `config.py` (`TOKEN_PRICING`), `resolution_cache.py`, `kernel_setup.py`, `orchestrator.py`, `auth.py` — have these open, not just linked; several of today's depth notes are drawn directly from bugs found and fixed in this exact code.

## Facilitation notes

- Protect Segment A's KV-cache arithmetic and Segment C's cost-gap moment — everything compresses before either of these do.
- Instructor depth notes are optional live — use them if the room's pace allows, skip them without guilt if not; the core run sheet holds at 120 minutes without them.
- Keep the Enterprise Support Desk as the only running example across all 3 weeks — a real, debuggable, GitHub-public system is the credibility advantage; use it.
