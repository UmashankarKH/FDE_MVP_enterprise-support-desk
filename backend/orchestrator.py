"""
The Triage/Orchestrator loop. This is the "loop engineering" centerpiece:
  - shared state object (TicketState) threaded through every agent
  - explicit max_turns so a stuck ticket can never loop forever
  - explicit exit conditions (auto_resolved, escalated, pending_human_approval, closed)
  - guardrails enforced here, not just trusted from the LLM's own output
  - fallback-to-human wired at two points: low RAG confidence, and critic-required review
Every step is persisted to Cosmos + audit-logged, so the pipeline is resumable
and the dashboard can show live progress mid-run.
"""
import logging

import question_cache
from agents import intake_agent, triage_agent, policy_rag_agent, resolver_agent, critic_agent, action_agent, escalation_agent
from cosmos_store import save_ticket, append_audit, next_ticket_number
from models import TicketState

logger = logging.getLogger("orchestrator")

TERMINAL_STATUSES = {"auto_resolved_and_closed", "escalated", "pending_human_approval", "closed"}

STEP_MAP = {
    "intake": intake_agent,
    "triaged": triage_agent,
    "rag_lookup": policy_rag_agent,
    "resolving": resolver_agent,
    "critic_review": critic_agent,
}


async def _checkpoint(state: TicketState):
    save_ticket(state)
    if state.agent_trace:
        last = state.agent_trace[-1]
        append_audit(state.ticketId, last["agent"], state.issue_text[:200], last["summary"])


def _apply_question_cache(state: TicketState) -> bool:
    """If this exact question already ended in a clean auto-resolve, reuse its
    classification and jump straight to the RAG step, skipping the Intake and
    Triage LLM calls. A fresh ticket number is still assigned, and RAG, the
    Resolver and the Critic all still run - see question_cache.py for the
    safety rule on what can enter the cache."""
    hit = question_cache.get(state.issue_text)
    if hit is None:
        return False
    state.category = hit["category"]
    state.request_type = hit["request_type"]
    state.ticket_number = next_ticket_number(state.request_type)
    state.status = "rag_lookup"
    state.log_step(
        "intake",
        f"Question cache hit - assigned {state.ticket_number} ({state.request_type}), "
        f"category={state.category}. Skipped the Intake and Triage LLM calls.",
        {"question_cache_hit": True},
    )
    return True


async def run_pipeline(state: TicketState) -> TicketState:
    """Runs the ticket through Intake -> Triage -> RAG -> Resolver -> Critic.
    Stops automatically at pending_human_approval, escalated, or when it can
    proceed straight to auto-resolve (then runs the Action Agent immediately).

    The routing decisions below (which agent runs next, when to stop, why)
    are logged under agent="manager" - this is the "Orchestrator" half of the
    architecture's "Triage/Orchestrator Agent" made visible: it's not an LLM
    call, it's the code that decides who gets to act next and when the loop
    is allowed to end. Everything else in this file is a plain state machine;
    these log lines are what let a learner see that machine's decisions."""

    await _checkpoint(state)  # initial save so it's visible in the dashboard right away

    if state.status == "intake" and _apply_question_cache(state):
        await _checkpoint(state)

    while state.turn_count < state.max_turns:
        if state.status == "auto_resolved":
            state.log_step(
                "manager",
                f"Exit condition met: auto_resolved -> dispatching Action Agent (turn {state.turn_count}/{state.max_turns})",
            )
            await action_agent.run(state)
            state.status = "closed"
            await _checkpoint(state)
            break

        if state.status in ("pending_human_approval", "escalated", "closed"):
            state.log_step(
                "manager",
                f"Exit condition met: {state.status} -> loop terminated (turn {state.turn_count}/{state.max_turns})",
            )
            await _checkpoint(state)
            break

        agent_module = STEP_MAP.get(state.status)
        if agent_module is None:
            state.log_step("manager", f"No agent registered for status={state.status} -> escalating")
            logger.warning("No agent registered for status=%s, escalating.", state.status)
            await escalation_agent.run(state, f"Unknown pipeline status: {state.status}")
            await _checkpoint(state)
            break

        # The orchestrator owns the turn count, not any individual agent -
        # every real agent-to-agent hop counts as one turn against the cap.
        state.turn_count += 1
        next_agent_name = agent_module.__name__.rsplit(".", 1)[-1]
        state.log_step(
            "manager",
            f"Routing turn {state.turn_count}/{state.max_turns}: status={state.status} -> {next_agent_name}",
        )
        await agent_module.run(state)
        if agent_module is critic_agent:
            # Only a clean auto-resolve on an auto_resolve-tagged article is
            # ever stored; anything needing human review is never cached.
            question_cache.maybe_store(state)
        await _checkpoint(state)

    else:
        # loop exhausted max_turns without reaching a terminal state
        state.log_step("manager", f"Exit condition met: max_turns ({state.max_turns}) exceeded -> escalating")
        await escalation_agent.run(state, f"Max turns ({state.max_turns}) exceeded without resolution")
        await _checkpoint(state)

    return state


async def resume_after_human(state: TicketState, decision: str, notes: str = "") -> TicketState:
    """Called when a human approves/rejects a pending_human_approval ticket."""
    state.human_decision = decision
    if decision == "approved":
        state.log_step("human", f"Human approved: {notes}" if notes else "Human approved")
        await action_agent.run(state)
        state.status = "closed"
    else:
        state.log_step("human", f"Human rejected: {notes}" if notes else "Human rejected")
        await escalation_agent.run(state, notes or "Human rejected the proposed resolution")

    await _checkpoint(state)
    return state
