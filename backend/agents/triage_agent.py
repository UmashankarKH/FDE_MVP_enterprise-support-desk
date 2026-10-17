"""Triage/Orchestrator Agent - decides the routing path. Cheap model (mini)."""
from kernel_setup import run_agent
from models import TicketState

SYSTEM_PROMPT = """You are the Triage Agent for an IT support desk. Given the issue category
and summary, flag whether it's a guardrail category. Every ticket is then grounded in the
knowledge base by the next step, so do not decide whether a lookup is needed.
Respond with ONLY JSON:
{"guardrail_category": <true|false - true for 2FA/security incidents or privileged/admin access requests>,
 "routing_note": "<short note on the issue type and why it is or is not a guardrail category>"}
"""


async def run(state: TicketState) -> TicketState:
    prompt = f"Category: {state.category}\nIssue: {state.issue_text}"
    result = await run_agent(
        "mini", SYSTEM_PROMPT, prompt, temperature=0.1, max_tokens=150,
        state=state, agent_label="triage",
    )

    if result.get("guardrail_category"):
        state.add_guardrail_flag(f"guardrail_category:{state.category}")

    # RAG is a hard gate for every ticket: the Resolver must be grounded in KB
    # citations, and the low-RAG-confidence guardrail only works if retrieval
    # always runs. Triage flags guardrail categories; it does not skip RAG.
    state.status = "rag_lookup"
    state.log_step("triage", result.get("routing_note", "Routed to RAG lookup"), result)
    return state
