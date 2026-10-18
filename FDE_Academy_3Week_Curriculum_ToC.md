**Trainer:** Umashankar K H
**Client:** FDE Academy
**Program:** Agentic Core at Pro Depth — 3-Week Curriculum

---

# FDE Academy — Agentic Core at Pro Depth
## 3-Week Curriculum: Core Technical Concepts & Table of Contents

*Throughline system for all 3 weeks: the Enterprise Support & Ticket Resolution Agent — a real, live, deployed multi-agent pipeline (Intake → Triage → Policy/RAG → Resolver → Critic → Action) running on Azure. Every session works against this same system, not a fresh hypothetical each time.*

---

## Part 1 — Core Technical Concepts

### 1. Model & Inference Economics
- **Tokens and tokenization** — cost is metered per-token because compute cost scales with sequence length, not call count; a 10-word and a 500-word prompt are billed on entirely different bases.
- **Prefill vs. decode** — prefill processes the entire input sequence in one parallel forward pass (compute-bound, GPU-FLOPs-limited, sets TTFT); decode generates one token at a time, each requiring a full pass through the model conditioned on all prior tokens (memory-bandwidth-bound — every step re-reads the KV cache — sets TPS).
- **TTFT vs. TPS trade-off** — batching multiple requests improves prefill throughput (parallel work, amortizes fixed compute overhead) but degrades per-stream decode TPS (concurrent streams compete for the same memory bandwidth reading each other's KV caches). Continuous/in-flight batching (vLLM, TGI-style schedulers) mitigates this by dynamically admitting new requests into decode slots as others finish, rather than batching statically.
- **KV cache size formula:** `layers × 2 × heads × head_dim × bytes_per_param × sequence_length` — the `2` accounts for both Key and Value tensors cached per layer per head. This is *per sequence*; multiply by concurrent sequence count for total serving memory footprint. This is precisely why long-context, high-concurrency serving is memory-bound, not compute-bound.
- **Mitigations when the KV cache formula gets uncomfortable:** grouped-query attention (GQA — multiple query heads share one KV head, shrinking the `heads` term), multi-query attention (MQA — all query heads share one KV head, the extreme case of GQA), and KV cache quantization (int8/int4, shrinking `bytes_per_param`).
- **Model tiering** — this project runs two deployments behind one `Settings` object: `MINI_DEPLOYMENT` (gpt-4.1-mini, $0.0004/$0.0016 per 1K in/out) for Intake and Triage (structured extraction, low reasoning depth required), `FLAGSHIP_DEPLOYMENT` (gpt-4o, $0.0025/$0.01 per 1K in/out) for Resolver and Critic (open-ended drafting and compliance judgment). Flagship is ~6x mini's per-token cost — tiering is the single highest-leverage cost lever available before touching caching or architecture at all.
- **Provider-side prompt caching vs. application-level response caching** — provider caching requires a byte-identical prefix of roughly 1,024+ tokens and caches the *computed KV state* server-side, saving prefill compute on repeat calls. Application-level caching (this project's `resolution_cache.py`) caches the *final output*, keyed on a semantic identifier (the RAG citation id) rather than exact text — a fundamentally different mechanism that works even when prompts vary in wording, but can only be used where re-serving an identical prior answer is actually correct (verified here via a RAG-confidence and resolver-confidence floor before any cache write).

### 2. Retrieval & Grounding (RAG)
- **Embeddings** — dense vector representations (this project: 1536-dimension, from `text-embedding-3-small`) where geometric proximity (cosine similarity) approximates semantic proximity. The embedding dimension is fixed by the model, not a design choice — index schema must match it exactly.
- **HNSW (Hierarchical Navigable Small World)** — the ANN index structure Azure AI Search uses by default: a multi-layer proximity graph, sparse long-range links at the top layer, dense short-range links at the bottom, giving ~O(log n) search instead of O(n) brute-force comparison. Tunable parameters: `m` (bi-directional links per node, default 4 — higher improves recall at the cost of index size), `ef_construction` (candidate list size during index build, default 400), `ef_search` (candidate list size per query, default 500 — the main runtime recall/latency dial).
- **Confidence as a hard gate, not a signal** — this project's RAG confidence is the top hit's raw `@search.score` from a *pure vector* query (`search_text=None`), deliberately not hybrid search — hybrid's reciprocal-rank-fusion scores land in a ~0.01–0.03 range regardless of match quality, which miscalibrates any fixed threshold. `RAG_CONFIDENCE_THRESHOLD = 0.45` sets a `low_rag_confidence` guardrail flag below that line; `critic_agent.py` then hard-overrides to `requires_human = True` when that flag is set, regardless of what the Critic's own LLM judgment concludes — the gate is enforced in code, not delegated to model discretion.
- **Filtered vs. unfiltered ANN search** — real enterprise retrieval is almost always filtered (tenant, category, date range); filtered-HNSW cost/recall behavior differs materially from the unfiltered benchmarks (BEIR, MTEB) most published numbers report.

### 3. Agentic Behavior & Tool Use
- **The real test for "agentic"** — not whether an LLM is involved, but whether the model decides, at inference time, when and whether to invoke a capability — vs. a fixed sequence of calls a human already ordered. This project's Resolver is the one genuinely agentic step: it can call `search_kb` or `get_customer_history` zero to `RESOLVER_MAX_TOOL_CALLS` (4) times, based on its own judgment of whether the citations it already has are sufficient.
- **Semantic Kernel auto-invoke internals** — `FunctionChoiceBehavior.Auto(auto_invoke=True, maximum_auto_invoke_attempts=N)` drives the tool-calling loop. A real, verified bug in SK 1.20.0: the internal loop calls `chat_history.add_message()` for every *intermediate* round that includes a function call, but never appends the *final* terminal response (whether reached via no-more-function-calls, or the max-attempts-exhausted forced final call) — silently under-counting both conversation history and, critically, token cost if not manually corrected with an explicit `history.add_message(response)` after the call returns.
- **Multi-round cost accounting** — a naïve cost tracer reading only the final API response under-counts total spend on any tool-calling turn; correct accounting sums `prompt_tokens`/`completion_tokens` across *every* real model round-trip in the turn (verified via a hand-built 2-round test: 950 prompt + 150 completion tokens totaled correctly across both rounds, not just the last).

### 4. Orchestration & Loop Engineering
- **Shared state object over message-passing** — `TicketState` (a dataclass) is threaded through every agent; each agent reads specific fields it needs and writes new fields back, including a `status` string that is the dispatch key into a `STEP_MAP` dict — no agent replays another agent's raw conversation, only its structured output fields.
- **Bounded orchestration loop** — `while state.turn_count < state.max_turns` (`max_turns = 6` default), incremented once per real `STEP_MAP` dispatch (5 stages on the happy path: intake → triaged → rag_lookup → resolving → critic_review — leaving 1 turn of headroom). A `while/else` on loop exhaustion routes to the Escalation Agent with an explicit "max turns exceeded" reason — the loop's own guardrail against infinite execution, independent of any single agent's LLM output.
- **Nested loop structure** — the outer 6-turn orchestrator loop is state-passing between distinct agents; the inner Resolver tool-calling loop (up to 4 rounds) is message-passing within one agent's own `ChatHistory` — two structurally different loop types, each bounded independently, neither aware of the other's counter.

### 5. Guardrails, Confidence & Human-in-the-Loop
- **Code-enforced guardrails, named explicitly:** `2fa_reset_requires_human` (any `reset_2fa` proposed action forces human review, full stop); `access_grant_without_critic_approval_blocked` (a `provision_access` action the Critic didn't approve is blocked, not just flagged); `resolver_confidence_below_50pct` (`AUTO_RESOLVE_CONFIDENCE_THRESHOLD = 0.50` is a hard floor independent of the Critic's own verdict); `kb_confidence_tag` (any top citation not explicitly curator-tagged `auto_resolve` defaults to human review, overriding the Critic's own LLM judgment about the category).
- **Why code-enforced, not prompt-enforced** — every guardrail above is a Python `if` statement in `critic_agent.py`, not an instruction in a system prompt. A prompt-based guardrail can be reasoned around by the model under adversarial or ambiguous input; a code-based one cannot.
- **Human-in-the-loop as resumable state, not a dead end** — `pending_human_approval` is a first-class terminal status of the orchestration loop, persisted to Cosmos DB; `resume_after_human()` re-enters the pipeline days later with the human's decision, running the Action Agent on approval or the Escalation Agent on rejection — the loop doesn't "start over," it resumes exactly where it paused.

### 6. Evaluation, Tracing & Monitoring
- **Per-call cost tracing formula:** `cost = (prompt_tokens/1000 × input_price_per_1k) + (completion_tokens/1000 × output_price_per_1k)`, computed per real model round-trip and summed into `TicketState.total_cost_usd` — correctly handling the SK multi-round under-counting bug named in Section 3.
- **Observability beyond uptime** — this project's `agent_trace` list logs a structured entry per agent step (agent name, summary, timestamp, extra fields like `cache_hit`, `tool_calls_made`, `guardrail_flags`); `token_usage` logs cost per call. Together they answer *why* a ticket resolved the way it did and *what it cost*, not just *whether the service responded*.
- **Diagnostic discipline** — a 500 Internal Server Error thrown by an unhandled backend exception can escape before Starlette's `CORSMiddleware` finishes wrapping the response, so the browser reports a CORS block instead of the real cause. Lived twice on this exact system (a missing Search index, later a deleted Cosmos DB account) — both resolved in minutes by reading `az containerapp logs show --follow` directly rather than trusting the browser console.

### 7. Deployment & Cloud Architecture
- **Deployment pipeline** — `az containerapp up --source .` triggers an ACR Tasks remote build (Dockerfile → image → push to registry) in one command; a missing `.dockerignore` was found silently re-uploading a 148MB `venv/` folder on every deploy and risking baking a real `.env` file into the image — fixed by excluding `venv/`, `__pycache__/`, `.env*` explicitly.
- **OAuth2/OIDC token acquisition failure modes** — MSAL's `acquireTokenSilent` falls back to a hidden-iframe SSO renewal when no cached/refresh token exists; browsers with strict third-party cookie blocking (Brave Shields, Safari ITP) block that iframe outright, surfacing as `BrowserAuthError: timed_out` rather than the expected `InteractionRequiredAuthError` — meaning naive fallback logic that only catches the latter silently fails. The interactive fallback (`acquireTokenPopup`) itself requires the call to originate synchronously within a user gesture; an `await` in between (e.g. the failed silent attempt) breaks that chain and the popup gets blocked too (`BrowserAuthError: popup_window_error`). Correct fix: prime the token cache proactively right after sign-in (outside any click handler), not reactively at click time.
- **Why a CORS error can be a red herring** — CORS is enforced by the *browser*, checking response headers the *server* must attach; if the server crashes before its middleware stack finishes running, no headers get attached at all, and the browser's only available explanation is "CORS blocked this," even though CORS was never the actual problem.
- **Infra resource identity persistence** — Entra ID app registrations are tenant-level objects, not resource-group-scoped; deleting a resource group does *not* delete associated app registrations, which can silently accumulate as orphaned duplicates with the same display name after an infrastructure rebuild.

### 8. Cost Optimization & Scale
- **Cost driver shift with scale** — at this project's demo scale, Azure AI Search bills as a fixed SKU-tier subscription (not metered per query), making vector infrastructure cost close to a rounding error; LLM generation (specifically the flagship, multi-round Resolver step) dominates instead. At web-scale (billions of vectors, high QPS), vector index memory/replica count for latency SLAs becomes the dominant, metered-by-consequence cost driver. The "representative" cost-breakdown percentages cited in generic industry sources are architecture-dependent, not universal constants.
- **Caching failure as a budget incident, not just a bug** — a caching layer silently falling back to full-cost behavior on every call is functionally indistinguishable from having no caching at all, except that nobody notices until the bill arrives — hence cache-hit rate belongs on a monitored dashboard with an alert threshold, not just in application logs.
- **Model-selection scorecard as method** — four scored dimensions (Capability via a held-out test set, Latency via p95 not mean, Cost via price-sheet arithmetic, Reversibility via how locked-in a swap would be), weighted by the client's actual priorities, not a vibe check.

### 9. Production Operations
- **Incident diagnosis order** (verified twice on this exact system): source logs first, not the symptom the frontend shows → identify the real exception class → correlate against what actually changed in the last deploy or infra edit → verify the fix against a clean log capture, not a single successful click.
- **Secret hygiene** — `.gitignore` and `.dockerignore` serve different purposes and must both explicitly exclude `.env*`/`venv/`; GitHub Push Protection (GH013) blocks a push containing a detected secret pattern *before* it reaches history — if caught pre-push, a full local `git init` reset is safer than attempting to rewrite a bad commit, since nothing reached the remote.
- **Resource naming and soft-delete collisions** — Cognitive Services (Azure OpenAI) custom subdomains can remain reserved after resource-group deletion even when `az cognitiveservices account list-deleted` returns empty; renaming rather than debugging the discrepancy is the pragmatic real-world workaround.

---

## Part 2 — Table of Contents (3 Weeks, 9 Sessions + Capstone)

### Week 1 — Foundations: The Model, Grounded and Tool-Enabled
| Session | Title | Core concepts covered |
|---|---|---|
| S1 *(today)* | The Model as a Component: What It Costs to Run | Group 1 — inference economics, KV cache, price arithmetic, model tiering |
| S2 | Grounding the Model — RAG as a Cost & Quality Lever | Group 2 — embeddings, HNSW, retrieval confidence as a hard gate |
| S3 | From Call to Agent — Tool-Calling & Bounded Autonomy | Group 3 — what makes it "agentic," SK auto-invoke internals, bounded loops |

### Week 2 — Orchestration, Safety & Observability
| Session | Title | Core concepts covered |
|---|---|---|
| S4 | Multi-Agent Architecture & Loop Engineering | Group 4 — shared state, bounded orchestration, nested loops |
| S5 | Guardrails, Confidence & Human-in-the-Loop | Group 5 — code-enforced guardrails, escalation, resumable HITL state |
| S6 | Evaluation, Tracing & Production Monitoring | Group 6 — cost/token tracing, real observability, diagnostic discipline |

### Week 3 — Deployment, Scale & Real-World Operations
| Session | Title | Core concepts covered |
|---|---|---|
| S7 | Deploying the Agent — Cloud Architecture End to End | Group 7 — deploy pipelines, OAuth2/OIDC failure modes, CORS-vs-crash diagnosis |
| S8 | Cost Optimization at Scale | Group 8 — production-scale cost profiles, caching-as-SLA, scorecards *(S1 touches the base of this — full depth lands here)* |
| S9 | Incidents, Debugging & Production Operations | Group 9 — incident methodology, secret hygiene, infra change management |
| Capstone | Live System Walkthrough & Defense | Defend the full architecture, cost model, and one real incident from the build — in front of the room, using the live deployed system |

---

*Share this doc with learners at the top of S1 as the map for the full 3 weeks.*
