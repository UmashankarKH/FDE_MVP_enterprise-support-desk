"""
Resolver Agent - drafts the actual resolution, grounded ONLY in RAG citations.
Flagship model.

This is the one agentic step in the pipeline: instead of only reading the
citations it was handed, the Resolver can call search_kb again (with a
refined query) or get_customer_history on its own, as many times as it
judges useful, up to RESOLVER_MAX_TOOL_CALLS - via Semantic Kernel's
automatic function calling (see kernel_setup.run_agent_with_tools and
agents/resolver_tools.py). Everything downstream (Critic review, the
confidence-floor guardrail, human-in-the-loop) is unchanged and still runs
as a deterministic gate on whatever the Resolver comes back with.
"""
import resolution_cache
from config import settings
from kernel_setup import run_agent_with_tools
from models import TicketState

SYSTEM_PROMPT = """You are the Resolver Agent for an IT support desk at a technology company.
Draft a resolution for the customer's issue using ONLY knowledge base citations as your
source of truth - do not invent policy or steps that aren't grounded in a citation. If the
citations don't clearly cover the issue, say so honestly and lower your confidence. This is
pure IT support - never propose anything involving money, refunds, or billing.

You have been given an initial set of citations from the RAG lookup step, included below.
You also have two tools available:
- search_kb(query): search the knowledge base again with a different or more specific
  query, if the citations you have don't clearly cover the customer's actual issue.
- get_customer_history(customer_id): look up this customer's past tickets, if the issue
  looks like a repeat problem or knowing what was already tried would change your answer.
Use these only if they would actually change your resolution or confidence - if the
citations you already have are clearly sufficient, answer directly without calling anything.

For device-level hardware/software incidents (camera, microphone/audio, connectivity,
VPN, install failures) where the citation's resolution steps are things a remote
diagnostic could check and fix automatically (driver state, OS privacy/permission
settings, stuck processes, service restarts) - propose "run_device_diagnostic"
instead of only describing manual steps, since the customer's device is enrolled in
management and can run a real fix.

For service requests that grant access or provision something (software installs/
licenses, VPN access, privileged/admin access) - propose "provision_access" once
the citation's steps are satisfied.

Once you're done (with or without calling any tools), respond with ONLY JSON:
{"resolution_text": "<the customer-facing resolution message>",
 "confidence": <float 0-1, how confident you are this fully resolves the issue>,
 "proposed_action": "<one of: none, create_ticket, reset_2fa, run_device_diagnostic, provision_access, escalate_to_human>"}
"""


async def run(state: TicketState) -> TicketState:
    top_citation_id = state.rag_citations[0]["id"] if state.rag_citations else None

    # Cost optimization: skip the flagship LLM call entirely if this exact KB
    # match has already been resolved before, and the RAG match was strong
    # enough to trust reusing it. Critic still reviews the result either way -
    # this only ever skips the drafting step, never the guardrail.
    cached = resolution_cache.get(top_citation_id, state.rag_confidence)
    if cached is not None:
        state.draft_resolution = cached["resolution_text"]
        state.resolver_confidence = cached["confidence"]
        state.status = "critic_review"
        state.log_step(
            "resolver",
            f"Cache hit on citation '{top_citation_id}' - reused prior resolution, "
            f"skipped the LLM call. confidence={state.resolver_confidence}, "
            f"action={cached['proposed_action']}",
            {"proposed_action": cached["proposed_action"], "cache_hit": True},
        )
        state.action_result = {"proposed_action": cached["proposed_action"]}
        return state

    citations_text = "\n".join(
        f"- {c['title']}: {c['resolution_steps']} | Policy: {c['policy_notes']}" for c in state.rag_citations
    )
    prompt = (
        f"customer_id: {state.customer_id}\n"
        f"Issue: {state.issue_text}\n\n"
        f"Knowledge base citations (from the initial RAG lookup):\n{citations_text}"
    )
    result, tool_calls_made = await run_agent_with_tools(
        "flagship",
        SYSTEM_PROMPT,
        prompt,
        plugin_name="resolver_tools",
        temperature=0.2,
        max_tool_calls=settings.RESOLVER_MAX_TOOL_CALLS,
        state=state,
        agent_label="resolver",
    )

    state.draft_resolution = result.get("resolution_text", "")
    state.resolver_confidence = result.get("confidence", 0.0)
    state.status = "critic_review"

    # Only cache a result worth replaying: a strong RAG match that produced a
    # confident draft (i.e. one that wouldn't have been forced to a human
    # anyway under the existing confidence-floor guardrail). The reason a
    # result was NOT cached goes into the trace so it's visible, not silent.
    skip_reason = None
    if not settings.RESOLVER_CACHE_ENABLED:
        skip_reason = "cache disabled"
    elif not top_citation_id:
        skip_reason = "no KB citation to key on"
    elif (state.rag_confidence or 0.0) < settings.RESOLVER_CACHE_MIN_RAG_CONFIDENCE:
        skip_reason = f"rag_confidence {state.rag_confidence} < cache minimum {settings.RESOLVER_CACHE_MIN_RAG_CONFIDENCE}"
    elif state.resolver_confidence < settings.AUTO_RESOLVE_CONFIDENCE_THRESHOLD:
        skip_reason = f"resolver_confidence {state.resolver_confidence} < {settings.AUTO_RESOLVE_CONFIDENCE_THRESHOLD}"

    cached_now = skip_reason is None
    if cached_now:
        resolution_cache.set(
            top_citation_id, state.draft_resolution, state.resolver_confidence, result.get("proposed_action")
        )

    state.log_step(
        "resolver",
        f"Drafted resolution, confidence={state.resolver_confidence}, "
        f"action={result.get('proposed_action')}, tool_calls={tool_calls_made or 'none'}, "
        f"{'stored in cache' if cached_now else 'not cached: ' + skip_reason}",
        {
            "proposed_action": result.get("proposed_action"),
            "tool_calls_made": tool_calls_made,
            "cache_hit": False,
            "cache_stored": cached_now,
            "cache_skip_reason": skip_reason,
        },
    )
    # stash for the critic/action agents
    state.action_result = {"proposed_action": result.get("proposed_action")}

    return state
