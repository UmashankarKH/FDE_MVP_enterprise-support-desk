FDE Academy — From MVP to Invoice
Live demo script: teaching the study note through the real deployed system
Trainer: Umashankar K H · Client: FDE Academy

---

## Why this maps almost perfectly

The study note's own "Try it yourself" exercise describes, almost field for field, the system you've
already built and deployed: *"a customer support MVP running with seven agents behind one
orchestrator... a full run takes 10 to 15 seconds... a budget alert set at $0.05 per iteration and the
system coming in at $0.15."* You don't need to invent an example for this session — you're standing in
front of the class's model answer, already running in Azure. Use that explicitly; it's a stronger opening
than any slide.

Structure follows the study note's own build order: MVP first, then the seven signals, then tracing
wired beside the call, then log quality, then cost itemisation and budget alerts, then the two
build-vs-buy case studies, then the exercise itself — run live against your real system instead of a
hypothetical.

---

## Part 1 — "Cost work has nothing to attach to until the MVP exists"

**Time: 10 min**

Walk the note's own pipeline (Problem → Data and pain points → Architecture → Components → Folder
structure → Files → MVP → Tracing) against this project's actual history, in order, honestly:

- Problem: enterprise support tickets, chosen specifically because it's relatable across every domain
  and touches RAG, multi-agent, tool-calling and human-in-the-loop in one build.
- Architecture and components: the seven-agent pipeline from the multi-agent design session.
- Folder structure and files: `backend/` — `app.py`, `orchestrator.py`, individual agent modules,
  `cosmos_store.py`, `resolution_cache.py`.
- MVP: the point where `run_pipeline` first returned a real resolution end to end, before any cost
  instrumentation existed.
- Tracing: added *after* — `total_cost_usd` and `token_usage` fields on `TicketState`, the
  `azure-monitor-opentelemetry` wiring in `app.py`, the resolution cache's hit/miss counters.

The honest point to make: cost instrumentation in this project was genuinely bolted on after the MVP
worked, not designed in from day one — which is exactly the order the note insists on, not a
retrofit to make the story look clean.

---

## Part 2 — Seven signals, mapped to what this system actually captures

**Time: 20 min**

| Signal | Where it lives in this project | Live demo |
|---|---|---|
| **Latency** | Container App request duration via App Insights; each ticket's total pipeline time | Open App Insights → Performance, show a real request's duration |
| **Tokens** | `token_usage` field per agent inside `TicketState` | Open a resolved ticket in the Admin Dashboard, show per-agent token breakdown |
| **Logs** | `agent_trace` array — one entry per agent, per ticket, plus App Insights `AppTraces` | Show a ticket's raw Cosmos document, point at `agent_trace` |
| **Throughput** | `GET /tickets/stats` — ticket volume over time | Admin Dashboard → Analytics tab, the trend chart built earlier |
| **Errors** | `guardrail_flags`, plus the Cosmos-deletion crash from the multi-agent session as a real errors story | App Insights → Failures blade |
| **Cost** | `total_cost_usd` on `TicketState`, `resolution_cache.stats()` for cache-driven savings | Cache Memory panel, cost field on a ticket detail drawer |
| **Requests** | Same `/tickets/stats` endpoint, request count | Same Analytics tab |

Land the note's own line here: **"None of it needs a platform to start."** The very first version of
cost tracking in this project was a single `time.time()` wrap and a running total — exactly the note's
2.37-second example — before Application Insights was ever wired in. Show that progression as the
actual arc: raw timer → structured field on shared state → full observability platform. That's the real
maturity curve, not a one-step jump.

---

## Part 3 — Tracing beside the call, not inside it

**Time: 10 min**

The note's LangSmith example — four environment variables, model call unchanged, runs start appearing
in a dashboard — has a near-identical twin in this project. Show `app.py`:

```python
if settings.APPLICATIONINSIGHTS_CONNECTION_STRING:
    from azure.monitor.opentelemetry import configure_azure_monitor
    configure_azure_monitor(
        connection_string=settings.APPLICATIONINSIGHTS_CONNECTION_STRING,
        logger_name="",
    )
```

Point at exactly what the note points at: this is a conditional block gated on one environment variable.
None of the seven agents' logic changed to get monitoring — the observation path is separate from the
answer path, wired beside the pipeline rather than into it. If the env var isn't set, the app runs
identically, just unobserved. That's the same "meter on the supply, not a change to the wiring" idea the
note makes with LangSmith, demonstrated with Azure Monitor instead.

**Live demo, if the workspace-p5Br Log Analytics setup from the last session is working:** run a live
chat in the app, then within a couple of minutes show the trace landing in Log Analytics. Use this
moment to repeat the note's own caveat out loud: *"traces take a moment to appear, so an empty dashboard
is not proof of failure"* — you hit exactly this uncertainty last session waiting on OpenAI diagnostic
logs, which makes it a true story rather than a borrowed one.

---

## Part 4 — Your cost answer inherits the quality of your logs

**Time: 15 min**

Put the note's two boxes side by side and score this project against them honestly.

**"A log that cannot answer"** — start/stop only, one line per application, no model name, billable and
free events mixed. Early in this project, before `total_cost_usd` existed, that's roughly what you had:
App Insights knew a request happened and how long it took, and nothing about what it cost or which
agent spent it.

**"A log that can"** — one record per agent per iteration, model called, tokens in/out, runtime, service
consumed, billable flag. That's what `agent_trace` plus `token_usage` on `TicketState` actually is today.
Open a real ticket document from Cosmos and read it against this checklist live, field by field, and let
the class confirm which box it belongs in.

Worth raising as an open question rather than a solved one: does this project currently separate
*billable* from *free* events the way the note recommends — e.g. does a cache hit (no LLM call) get
logged distinctly from a cache miss (real LLM spend)? Check `resolution_cache.py`'s `_record()` calls
live — `hit`, `miss`, `miss_low_confidence`, `expired` are exactly that billable/non-billable tagging,
built for a different reason (demonstrating the cache) but structurally the same idea the note is asking
for.

---

## Part 5 — Itemised billing and the budget alert, tied back to last session

**Time: 10 min — mostly a callback**

This is where Task #8 from the previous session (Azure Cost Management walkthrough) and this note meet.
Re-show Cost analysis grouped by resource in the `FDE` resource group — the note's own example (a
database at ₹476 across 25 days, a container registry at ₹388) is the same shape as what's sitting in
your subscription right now for Cosmos, the Container App, and AI Search. If you set the Budget alert
from that earlier walkthrough, show it live: that alert *is* the note's "cap of $0.05 per iteration
against an actual $0.15" idea, just expressed as a monthly ceiling instead of a per-iteration one — which
sets up the note's own "one more layer" question in Part 7 below.

---

## Part 6 — The two build-vs-buy case studies, mapped to real decisions already made

**Time: 15 min**

### Case 1 — "price the deletion first"

The note's timesheet example: don't tune the model, delete the step, unless a real constraint (API
refusal, per-seat licence) overrules you. This project's own version of that instinct: the Resolver
response cache. The deletion nobody could actually take was "stop calling the LLM for repeat issues" —
you couldn't literally delete the Resolver call, since every ticket still needs a personalised reply, but
the cache achieves the same economic effect for the subset of tickets that are semantically repeats
(same top RAG citation). Show `resolution_cache.py`'s own comment block explaining exactly this
reasoning — it was written for a different session, but it's the same argument as the note's timesheet
case, in your own words, in production code.

### Case 2 — "is this actually an agent?"

The note's identity-document example: no decision to route means no agent, just an ETL pipeline with a
drift-retrain trigger. Turn this into a live discussion question about your *own* seven agents rather than
a hypothetical: which of the Intake, Triage, RAG, Resolver, Critic, Action, and Escalation agents
genuinely make a choice an LLM is suited to, and which are closer to deterministic pipeline steps wearing
an "agent" label? Worth being honest in the room — the RAG Agent's job (fetch top-k, compute confidence)
has no branching decision in it at all; it's a retrieval step, not a reasoning step, even though it's
labelled an "agent" in the architecture diagram. The Critic Agent, by contrast, is unambiguously a real
decision point. This is a genuinely open design question, not one with a clean answer — let the room
argue it.

---

## Part 7 — Run the "Try it yourself" exercise live, with real numbers

**Time: 20 min — the closing exercise**

Don't paraphrase the note's exercise. Read it to the room almost verbatim, because it already describes
your system:

*"A customer support MVP is running with seven agents behind one orchestrator. A full run takes 10 to 15
seconds. The budget alert is set at $0.05 per iteration and the system is coming in at $0.15. Someone
proposes switching to a cheaper model across all seven agents."*

Give the room the same fifteen minutes the note prescribes, same three questions:
1. The three places you'd look first for the $0.10 overshoot.
2. The one instrumentation change that has to land before any optimisation.
3. The cheapest likely fix, given latency is already acceptable.

**Then — the part the note can't do and you can — pull up the real numbers.** Open a resolved ticket in
your Admin Dashboard and show the actual `agent_trace` with real per-agent costs. Ask: does the real
data support the note's model answer (overshoot concentrated in one or two agents, not spread evenly
across all seven)? If your own Critic or Resolver agent is visibly the most expensive line item, that's
the exact "which one" the note's model answer says per-agent tracing exists to find — except you're
pointing at a real number instead of asserting the principle.

Close on the note's own "one more layer" question, but answered against your real config: what happens
to `RAG_CONFIDENCE_THRESHOLD` or `RESOLVER_CACHE_MIN_RAG_CONFIDENCE`-driven spend if ticket volume
doubles? A per-iteration cap behaves differently from the resource-group-level monthly Budget alert set
up in Part 5 — make the room say out loud which one your client would actually care about, same as the
note's closing line.

---

## Appendix — quick reference table for your own prep

| Study note concept | This project's real equivalent |
|---|---|
| Seven monitoring signals | `token_usage`, `agent_trace`, App Insights traces/failures, `/tickets/stats` |
| Four env vars wire tracing beside the call | `APPLICATIONINSIGHTS_CONNECTION_STRING` gate in `app.py` |
| "A log that can" vs "a log that cannot" | `TicketState.agent_trace` + `token_usage` vs. early pre-instrumentation state |
| Itemised cloud billing | Cost Management grouped by resource in `FDE` resource group (prior session) |
| Budget alert, cap vs actual | Azure Budget alert set on the resource group |
| "Price the deletion first" | `resolution_cache.py`'s citation-keyed cache |
| "Is this actually an agent?" | Open question: RAG Agent (retrieval, no branch) vs Critic Agent (real decision) |
| Try-it-yourself exercise | Literally this system's own architecture — use real ticket traces as the answer key |
