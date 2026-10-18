FDE Academy — Multi-Agent Design Session
Live demo script: teaching the pre-read through the real deployed system
Trainer: Umashankar K H · Client: FDE Academy

---

## How to use this document

Learners already have the pre-read ("Designing a multi-agent system: boundaries, contracts and
contained failure"). It gave them the vocabulary — agent boundary, orchestrator, synchronous vs
event-driven, API contract, circuit breaker, graceful degradation — using a kitchen and a clinic as
metaphors.

This session does what the pre-read explicitly said it wouldn't: the real teaching. Instead of new
metaphors, every concept gets pointed at a specific file, a specific log line, or a specific incident from
building and running the Enterprise Support & Ticket Resolution Agent — including three production
bugs that happened in this exact system, which are better teaching material than any invented example
because they are unresolved-at-the-time, not written-to-illustrate-a-point.

Structure mirrors the pre-read's own "how the session builds up" table exactly, so learners feel the
thread continue rather than restart:

| Pre-read part | This session's demo |
|---|---|
| Decomposition | Walk the 7-agent pipeline, agent by agent, reading real code |
| Communication | Show why this system is almost entirely synchronous, and the one place it isn't |
| Build, buy, integrate | Audit every dependency in the stack against that exact decision |
| API contracts | Break one on purpose, live, using the system's real shared state object |
| Failure isolation | Replay three real outages from this project as case studies |
| Your design | Learners present; you critique using the same six questions the pre-read ended with |

Suggested total time: 2 hours (matches the pre-read's session-length assumption). Timings below are a
guide — the design-review segment expands to fill whatever time is left after the demo.

---

## Part 1 — Decomposition: the seven agents, one job each

**Time: 20 min**

### Recap (30 seconds, don't over-explain — they read this already)

One responsibility per agent. The test: what is the one thing this is responsible for?

### Live demo

Open `orchestrator.py` and `app.py` side by side. Walk the pipeline in the order a real ticket moves
through it:

1. **Intake Agent** — reads raw issue text, produces structured fields (`request_type`, initial
   classification). Single job: turn unstructured customer language into structured data. It does not
   decide routing and does not touch policy.
2. **Triage/Orchestrator** — decides which path the ticket takes. Holds no domain logic of its own —
   this is the exact "orchestrator" role from the pre-read's clinic reception desk. It does not check
   policy and does not draft a resolution.
3. **Policy/RAG Agent** — the only agent that touches Azure AI Search. Single job: retrieve the
   relevant KB document and a confidence score. It does not decide what to tell the customer.
4. **Resolver Agent** — drafts the actual resolution text, using the RAG Agent's citation as grounding.
   It does not decide whether that draft is good enough to send.
5. **Critic/Evaluator Agent** — the quality gate. Single job: review the Resolver's draft and either
   pass it or block it. This is the agent that enforces the guardrail "no refund without Critic
   sign-off" — point at this line in the pre-read's own vocabulary: this is a manually-coded business
   rule sitting at an agent boundary, not something the LLM is trusted to self-police.
6. **Action Agent** — the only agent with write access to anything real (Intune device diagnostic,
   access provisioning). Every other agent up to this point could be deleted and nothing outside the
   system would notice. This one touches the real world, which is exactly why it's isolated as its own
   step with its own guardrail check before it.
7. **Escalation Agent** — the human-in-the-loop path when Critic or confidence gating rejects
   auto-resolution.

**Show this live:** open the Admin Dashboard, click into any resolved ticket, and show the
`reasoning_steps` array — this is the seven-agent trace made visible, in the browser, from a real ticket
that ran seconds ago.

### The question to actually ask them

Point at the pre-read's own line: "what is the one thing this is responsible for?" Ask the room: which
of these seven agents could you delete and have the *others* silently absorb its job without anyone
noticing for a week? (Answer worth drawing out: none of them cleanly — that's the boundary test passing.
Contrast with a bad design where two agents both quietly do validation.)

---

## Part 2 — Communication: why this system is (almost) entirely synchronous

**Time: 15 min**

### Recap

Ask: do I need the answer before I can take the next step? If yes — synchronous, the call waits.

### Live demo

This is the honest, slightly uncomfortable answer: **the core pipeline has almost no event-driven
communication in it.** Show `orchestrator.run_pipeline` — it's a straight `await` chain: Intake, then
Triage, then RAG, then Resolver, then Critic, then the branch. Every step is synchronous because every
step's input is the previous step's output. Resolver cannot draft without RAG's citation. Critic cannot
review without Resolver's draft. There is no scenario where these could run in parallel or fire-and-forget
— the pre-read's own decision rule ("do I need the answer before the next step?") answers itself here, and
the answer is yes at every single edge.

**The one place it isn't synchronous:** email intake. The Logic App's "When a new email arrives" trigger
is a pure event — nobody is waiting on that email to arrive, the Logic App reacts to it independently and
calls `POST /api/email-intake` whenever it happens. That's the system's only genuine event-driven edge,
and it's worth showing learners *why* it's the one: because unlike every internal agent-to-agent hop,
nothing in the system needs to block waiting for an email.

### Discussion prompt

Ask learners to look at their own pre-read use case (HR assistant, etc.) and find their own equivalent
split: which edges are forced synchronous because of a real data dependency, and which are secretly
synchronous just because it was easier to write that way? The second kind is the mistake the pre-read is
warning about.

---

## Part 3 — Build, buy, integrate: audit the real stack

**Time: 15 min**

### Recap

Control, speed, cost, dependency. Three real options, not a binary.

### Live demo

Walk the actual FDE stack and classify every piece live, on the whiteboard, with the room:

| Component | Decision | Why |
|---|---|---|
| Agent orchestration logic | **Build** | This is the actual product — the boundaries and routing are the thing being sold to a client. You don't buy your own value proposition. |
| LLM inference | **Buy/integrate** (Azure OpenAI) | Training a foundation model is not in scope for any FDE engagement. Integrate, and treat the model as swappable — the project's own portability note ("swap `callLLM()` to Gemini") proves the API contract was designed to make this cheap later. |
| Vector search / RAG retrieval | **Buy/integrate** (Azure AI Search) | Building an ANN index from scratch is a multi-week systems project by itself (see: HNSW discussion from earlier in this course) — buying it is correct unless search cost or control is the actual client problem. |
| State storage | **Buy/integrate** (Cosmos DB) | But *serverless*, not provisioned — a real cost decision made mid-project when provisioned throughput turned out to be billing ~$24/month idle. Worth telling this story exactly as it happened. |
| Auth | **Buy/integrate** (Entra ID) | Nobody builds their own identity provider for an internal enterprise tool. |
| Response caching | **Build** (`resolution_cache.py`) | Small, specific, and coupled tightly to this system's own RAG citation ids — no off-the-shelf product fits this shape at this scale. |

### The point to land

Every "buy" decision above is a dependency the system doesn't control — and every one of them shows up
again in Part 5 as a failure mode. Build/buy isn't just a cost decision, it's a decision about *where your
failure isolation boundaries have to go*. That's the bridge into the next section.

---

## Part 4 — API contracts: break one on purpose

**Time: 20 min — the most hands-on section**

### Recap

The pre-read's own example: `payload['user_id']` when the field is actually `customer_id`. `KeyError`.
Two correctly-written agents, one broken workflow.

### Live demo — this system's real equivalent, arguably a worse bug

Open `app.py`'s `_build_ticket_response`. Show this code:

```python
reasoning_steps = [step_by_label.get(label, f"{label} skipped") for label in _AGENT_LABELS]
```

Explain what this actually is: `_AGENT_LABELS` is a fixed-order list. The UI consumes
`reasoning_steps[i]` by **position**, not by name. The contract between backend and frontend isn't a
field name — it's an array index.

**Now break it live.** In a scratch branch (not the deployed one), reorder `_AGENT_LABELS` — swap
"Critic Agent" and "Manager Agent" — and rerun a ticket. Show the result: **no error is raised.** The
pipeline runs fine. The UI renders fine. The dashboard shows a completely valid-looking reasoning trace
— just with the wrong agent's summary under the wrong agent's name. Nobody sees an exception. Nobody
gets paged. The bug is silent.

Compare this explicitly to the pre-read's `KeyError` example: that failure was loud — a stack trace,
instantly visible. This one is worse, because a **positional contract fails silently** where a
**named-field contract at least throws.** This is the single most useful thing to teach in this section:
API contracts aren't just about what fields exist, they're about *how the consumer finds them* — and
implicit ordering is a weaker contract than an explicit key, even though it looks simpler in the code.

### Second real example — the SK auto-invoke bug

If time allows: tell the Semantic Kernel 1.20.0 story. SK's auto-invoke loop silently failed to append
the final response to `chat_history` — only intermediate function-call rounds got appended. This is a
contract violation *inside a framework dependency*, not code you wrote — and it broke token/cost
accounting silently until a manual `history.add_message(response)` fix was added. Point: contracts you
didn't write yourself (a library's internal behavior) still need the same suspicion as contracts you did.

### Discussion prompt

Ask the room to look back at their own pre-read design and find one place they're passing data by
position or by assumed shape instead of by explicit, named, validated contract. Have two or three
volunteers describe theirs out loud.

---

## Part 5 — Failure isolation: three real outages, not hypotheticals

**Time: 25 min**

### Recap

Timeouts, retries, circuit breakers, fallbacks, queues. The recommendation-agent-times-out-and-the-page-
still-loads example from the pre-read.

### Case study 1 — the opposite of graceful degradation (what NOT to do)

Tell it straight: Cosmos DB was deleted mid-project to save cost. Show `cosmos_store.py` — the
`CosmosClient(...)` construction and `create_database_if_not_exists()` call happen **at module import
time**, outside any function. Ask the room to predict what happens when Cosmos is deleted and the app
restarts. Then show the actual log output: the entire app — every endpoint, not just ticket-related ones
— crashed on boot with a connection failure, surfaced to the browser as a bare CORS error that had
nothing to do with CORS.

This is a direct, real violation of the pre-read's own principle: "the recommendation agent failed and
the page still loaded." Here, a dependency failure took the *whole* system down, exactly the "one agent,
five jobs" failure mode the pre-read opens with — except the fragility wasn't inside one agent's logic,
it was in *when* a dependency connection gets constructed. Ask: what would the fix look like if this had
to be graceful — lazy-connect on first use, wrapped in a try/except, with a clear "storage unavailable"
response instead of a crash?

### Case study 2 — a real guardrail acting as a circuit breaker

RAG confidence gating: `RAG_CONFIDENCE_THRESHOLD = 0.45`. Show the Resolver cache's
`RESOLVER_CACHE_MIN_RAG_CONFIDENCE` check and the human-approval fallback path. This is failure
isolation working correctly: when retrieval confidence is too low to trust, the system doesn't guess —
it routes to a human, the same shape as the pre-read's clinic ("if the lab is closed, you still get seen").
Show a live ticket in the Admin Dashboard sitting in the human-approval queue and explain which
threshold put it there.

### Case study 3 — retry-with-fallback in the auth layer

The MSAL `BrowserAuthError: timed_out` → `popup_window_error` chain from earlier in this project.
Silent token refresh (iframe-based) got blocked by browser third-party cookie policy; the fix was a
proactive `acquireTokenSilent` warm-up right after login, falling back to `acquireTokenRedirect`. This
is a retry-with-fallback pattern in the wild, in a layer (auth) that nobody thinks of as needing failure
isolation until it breaks in front of a user.

### Live: show the Cache Memory panel as a fourth, quieter example

Open the Admin Dashboard's Cache Memory panel (built earlier this course). A cache miss isn't a failure
— but structurally it's the same shape: a cheap path fails its precondition (no cached entry, or RAG
confidence too low to trust a cached answer) and falls through to the expensive-but-reliable path (a
fresh LLM call). Worth pointing out that "fallback" doesn't always mean "something broke" — sometimes
it just means "the fast path's conditions weren't met."

### Discussion prompt — the pre-read's own question 6

"If one agent fails, what should the customer still see?" Go around the room and have each learner
answer this for their own chosen use case, one sentence each, before moving to Part 6.

---

## Part 6 — Your design: review using the pre-read's own six questions

**Time: remainder of session**

Learners present their six-part design (business problem, agents and responsibilities, communication
choices, build/buy/integrate, API contracts, failure fallback per agent) — exactly as briefed in the
pre-read.

For each presentation, run it against the same six questions the pre-read ended with, now as a review
checklist rather than a self-check:

1. Why did you split it this way, and what did you give up?
2. Is there a boundary here that's actually two responsibilities wearing one name? (The most common
   design flaw — watch for an agent whose description contains "and.")
3. Which arrows are synchronous because the data genuinely requires it, and which are synchronous
   because it was easier to write?
4. Where's a build/buy call you'd defend differently in front of a client than you would to a peer?
5. Pick one arrow on the board and ask: what field does the receiving agent assume exists? Has anyone
   checked that assumption is written down anywhere?
6. Pick one box and ask: if this agent is down for ten minutes, what does the end user see? "An error" is
   not an acceptable answer — push for the specific degraded-but-useful response.

Close by connecting back to the live system one last time: everything just reviewed exists, running, in
Azure, and every one of the six questions above has a real, sometimes embarrassing, answer in it —
that's the difference between a design exercise and an FDE engagement.

---

## Appendix — quick reference of real incidents used above, for your own prep notes

| Incident | Concept it demonstrates | Where in code |
|---|---|---|
| Positional `reasoning_steps` array | Weak vs strong API contracts | `app.py`, `_build_ticket_response` |
| SK 1.20.0 auto-invoke history bug | Contracts inside third-party dependencies | orchestrator / SK integration |
| Cosmos deleted → app-wide crash | Failure isolation violated (module-import-time coupling) | `cosmos_store.py` |
| RAG confidence gate → human approval | Guardrail as circuit breaker | RAG Agent / Resolver Agent |
| MSAL silent-auth timeout → popup fallback | Retry-with-fallback outside the "obvious" layer | `LoginGate.tsx` |
| Resolution cache miss → LLM fallback | Fallback that isn't a failure | `resolution_cache.py` |
| Cosmos provisioned → serverless switch | Build/buy revisited under a real cost constraint | Azure infra decision |
