# Guardrails in the Enterprise Support Desk

Trainer: Umashankar K H | Client: FDE Academy

There is no single guardrail file. Each rule is plain Python that runs where it applies, so it holds even
if the model says something different. This page lists every rule, where it lives, and what it does.

## How a guardrail works

1. A rule checks the ticket's state (confidence, action type, KB tag, turn count).
2. If the rule fires, it adds a flag with `add_guardrail_flag()` (`backend/models.py`) and/or forces the
   ticket to a human. Flags are saved on the ticket in Cosmos DB under `guardrail_flags`.
3. The Critic reads all flags. If any rule demands a human, the status becomes `pending_human_approval`
   and the ticket waits in the Admin Dashboard approval queue.
4. The Action Agent only runs after a clean auto-resolve or an explicit human approval.

## The rules

| # | Rule | Where | Effect |
|---|------|-------|--------|
| 1 | Retrieval confidence below 0.45 | `backend/agents/policy_rag_agent.py` | Adds `low_rag_confidence`; the Critic then forces human review |
| 2 | Security or admin-access ticket (2FA, privileged access) | `backend/agents/triage_agent.py` | Adds `guardrail_category:<category>` |
| 3 | 2FA reset proposed | `backend/agents/critic_agent.py` | Adds `2fa_reset_requires_human`; always a human |
| 4 | Access grant not approved by the Critic | `backend/agents/critic_agent.py` | Adds `access_grant_without_critic_approval_blocked`; human required |
| 5 | Resolver confidence below 0.50 | `backend/agents/critic_agent.py` | Adds `resolver_confidence_below_50pct`; human required |
| 6 | Top KB article not tagged `auto_resolve` | `backend/agents/critic_agent.py` | Adds `kb_confidence_tag:<tag>`; human required |
| 7 | Critic model says `requires_human` | `backend/agents/critic_agent.py` | Human required (one input among the rules above) |
| 8 | Maximum 6 agent turns | `backend/orchestrator.py` (`max_turns`) | Loop stops and the ticket is escalated |
| 9 | Exit conditions (auto-resolved, pending approval, escalated, closed) | `backend/orchestrator.py` | Loop ends; unknown status escalates |
| 10 | Action runs only after approval | `backend/orchestrator.py`, `backend/agents/action_agent.py` | Action Agent runs on `auto_resolved` or after `resume_after_human` approves |
| 11 | Decision accepted only on a pending ticket | `backend/app.py` (`/tickets/{id}/decision`) | Rejects approve or reject on any other status |
| 12 | Resolver tool-call limit (4) | `backend/config.py` (`RESOLVER_MAX_TOOL_CALLS`) | Caps the Resolver's tool loop |
| 13 | Resolution cache only reuses strong matches (RAG at least 0.55) | `backend/resolution_cache.py`, `backend/agents/resolver_agent.py` | A weak match never replays a cached answer |
| 14 | Question cache stores only clean auto-resolves on `auto_resolve` articles | `backend/question_cache.py` | A flagged or human-reviewed ticket can never enter the cache |
| 15 | API requires a valid Entra ID token | `backend/auth.py` | Rejects unauthenticated calls (when `ENTRA_AUTH_ENABLED` is true) |
| 16 | Email webhook needs a shared secret | `backend/app.py` (`_verify_email_webhook_secret`) | 401 without the right header |

## Thresholds (all in `backend/config.py`)

| Setting | Default | Meaning |
|---------|---------|---------|
| `RAG_CONFIDENCE_THRESHOLD` | 0.45 | Below this, retrieval is too weak to trust |
| `AUTO_RESOLVE_CONFIDENCE_THRESHOLD` | 0.50 | Resolver confidence floor for auto-resolve |
| `RESOLVER_CACHE_MIN_RAG_CONFIDENCE` | 0.55 | Minimum match strength to cache or replay an answer |
| `MAX_TURNS` | 6 | Hard cap on agent hops per ticket |
| `RESOLVER_MAX_TOOL_CALLS` | 4 | Cap on the Resolver's tool calls |

Each can be overridden with an environment variable of the same name on the Container App.

## Where the numbers come from

- **RAG confidence** is the top Azure AI Search vector score, capped at 1.0 (`backend/search_client.py`).
- **Resolver confidence** is the model's own 0 to 1 self-estimate, not a formula. That is why it is never
  trusted alone: the rules above sit around it.
- **KB tag** (`auto_resolve`, `human_review_required`, `human_review_if_data_loss`) is curated by us in
  `rag/kb_dataset.json`, so it is deterministic.

## Known gap to explain honestly

The "Critic and Guardrails" card on the chat page shows an auto-resolve threshold of 75%. That text is
display only and enforces nothing. The backend enforces 0.50 (`AUTO_RESOLVE_CONFIDENCE_THRESHOLD`).

## Teaching points

- Rules are code, not prompts: the model can disagree and the rule still wins.
- The model's own `requires_human` answer is one vote; any single rule can override it toward a human.
- A cache hit never bypasses review: the Critic runs on every ticket, cached or not.
- Defaults lean toward a human: any article not explicitly tagged `auto_resolve` goes to review.

## Test prompts that reach a human

| Type this | Trigger |
|-----------|---------|
| I lost my phone and I'm locked out of two-factor authentication | Rules 3 and 6 |
| I need admin access to the production server | Rules 4 and 6 |
| My app keeps crashing and I lost my unsaved work | Rule 6 (`human_review_if_data_loss`) |
| What is the best recipe for biryani? | Rule 1 (no matching article) |
