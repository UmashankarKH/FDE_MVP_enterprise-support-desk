"""
FastAPI wrapper around the agent pipeline - this is the one API the exported
frontend (chat portal + admin dashboard) talks to. Keep every frontend call
behind this single base URL so swapping backends later is a config change,
not a rewrite (per the portability note in the plan).
"""
import logging

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import question_cache
import resolution_cache
from auth import verify_token
from config import settings
from cosmos_store import get_ticket, get_stats, list_tickets
from models import TicketState
from orchestrator import run_pipeline, resume_after_human

logging.basicConfig(level=logging.INFO)

# Monitoring - every request, LLM call span, log line and unhandled exception
# flows into the fde-app-insights resource once this env var is set. Left as
# a no-op if unset so local dev doesn't need an App Insights connection.
if settings.APPLICATIONINSIGHTS_CONNECTION_STRING:
    from azure.monitor.opentelemetry import configure_azure_monitor

    configure_azure_monitor(
        connection_string=settings.APPLICATIONINSIGHTS_CONNECTION_STRING,
        logger_name="",  # capture the root logger so every module's logging.* calls ship too
    )
    logging.getLogger("monitoring").info("Azure Monitor OpenTelemetry configured")

app = FastAPI(title="Enterprise Support & Ticket Resolution Agent API")

if settings.APPLICATIONINSIGHTS_CONNECTION_STRING:
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    FastAPIInstrumentor.instrument_app(app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.ALLOWED_ORIGIN] if settings.ALLOWED_ORIGIN != "*" else ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class NewTicketRequest(BaseModel):
    issue_text: str
    channel: str = "chat"
    customer_id: str = "unknown"


class HumanDecisionRequest(BaseModel):
    decision: str  # "approved" | "rejected"
    notes: str = ""


class ChatRequest(BaseModel):
    message: str
    user_id: str = "CUST-8801"
    channel: str = "chat"


class EmailIntakeRequest(BaseModel):
    from_email: str
    subject: str = ""
    body: str = ""  # plain text - Logic App runs "HTML to text" before posting here


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/tickets")
async def create_ticket(req: NewTicketRequest, claims: dict = Depends(verify_token)):
    state = TicketState(
        issue_text=req.issue_text,
        channel=req.channel,
        customer_id=req.customer_id,
        max_turns=settings.MAX_TURNS,
    )
    state = await run_pipeline(state)
    return state.to_cosmos_doc()


@app.get("/tickets")
def get_all_tickets(limit: int = 50, claims: dict = Depends(verify_token)):
    return list_tickets(limit=limit)


@app.get("/tickets/stats")
def get_ticket_stats(claims: dict = Depends(verify_token)):
    """Real usage numbers for the Admin Dashboard's Analytics tab: unique
    customers who have used the app, and a resolved / escalated / not-yet-
    resolved breakdown across every ticket in Cosmos DB - not just the
    tickets created in the current browser session. Registered ahead of
    /tickets/{ticket_id} so 'stats' isn't swallowed as a ticket_id."""
    return get_stats()


@app.get("/cache/stats")
def cache_stats(claims: dict = Depends(verify_token)):
    """Live resolution-cache stats for the Admin Dashboard's cache-memory
    panel - real hit/miss counters and recent events since this process
    started, not a mock. Same data resolution_cache.py already tracks
    internally for cost optimization; this just makes it visible. The
    question-level cache stats ride along under their own key."""
    return {**resolution_cache.stats(), "question_cache": question_cache.stats()}


@app.get("/tickets/{ticket_id}")
def get_one_ticket(ticket_id: str, claims: dict = Depends(verify_token)):
    state = get_ticket(ticket_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return state.to_cosmos_doc()


@app.post("/tickets/{ticket_id}/decision")
async def submit_human_decision(ticket_id: str, req: HumanDecisionRequest, claims: dict = Depends(verify_token)):
    state = get_ticket(ticket_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    if state.status != "pending_human_approval":
        raise HTTPException(status_code=400, detail=f"Ticket is not pending approval (status={state.status})")
    if req.decision not in ("approved", "rejected"):
        raise HTTPException(status_code=400, detail="decision must be 'approved' or 'rejected'")

    state = await resume_after_human(state, req.decision, req.notes)
    return state.to_cosmos_doc()


# --- Compatibility adapter for the exported frontend (LiveChatInterface.tsx) ---
# The UI was built against a simpler {message, user_id, channel} -> reasoning_steps
# contract. Rather than rewrite the frontend, this route runs the exact same real
# pipeline as /tickets and reshapes the result into what the UI already expects.
_AGENT_LABELS = ["Intake Agent", "Triage Agent", "RAG Agent", "Resolver Agent", "Critic Agent", "Manager Agent", "Action Agent"]
_TRACE_AGENT_TO_LABEL = {
    "intake": "Intake Agent",
    "triage": "Triage Agent",
    "policy_rag": "RAG Agent",
    "resolver": "Resolver Agent",
    "critic": "Critic Agent",
    "manager": "Manager Agent",
    "action": "Action Agent",
}


def _build_ticket_response(state: TicketState) -> dict:
    """Shared shaping logic for any channel that runs the real pipeline and
    needs a UI/reply-ready result: chat (reasoning_steps consumed by
    LiveChatInterface.tsx) and email (resolution + ticket_number consumed by
    the Logic App's reply action). Keeping this in one place means the
    device-diagnostic/provisioning text enrichment and the loop-engineering
    readout can't drift between channels."""
    # Reduce the full agent_trace down to one line per core stage, in a fixed
    # order, since the chat UI maps reasoning_steps[i] -> _AGENT_LABELS[i] by index.
    step_by_label = {}
    for entry in state.agent_trace:
        label = _TRACE_AGENT_TO_LABEL.get(entry["agent"])
        if label:
            step_by_label[label] = entry["summary"]
    reasoning_steps = [step_by_label.get(label, f"{label} skipped") for label in _AGENT_LABELS]

    confidence_pct = round((state.resolver_confidence or 0) * 100)
    sources = [c["title"] for c in state.rag_citations]
    action_type = (state.action_result or {}).get("proposed_action")
    ui_status = "pending_human" if state.status in ("pending_human_approval", "escalated") else "resolved"

    resolution_text = state.draft_resolution or "Your request has been routed to a specialist for review."
    if action_type == "run_device_diagnostic" and (state.action_result or {}).get("executed"):
        finding = state.action_result.get("diagnostic_finding")
        fix = state.action_result.get("remediation_applied")
        if finding and fix:
            resolution_text += (
                f"\n\nWe also ran an automated diagnostic on your device via Intune: "
                f"{finding} We applied a fix automatically — {fix}"
            )
    elif action_type == "provision_access" and (state.action_result or {}).get("executed"):
        provisioning_action = state.action_result.get("provisioning_action")
        if provisioning_action:
            resolution_text += f"\n\nAccess has been provisioned: {provisioning_action}"

    if ui_status == "pending_human":
        resolution_text += (
            "\n\nA member of our support team is reviewing this before it's finalized "
            "— you'll get a follow-up once it's confirmed."
        )

    # Loop-engineering readout - the actual mechanics behind the reasoning
    # trace: how many agent-to-agent turns this ticket took against the hard
    # cap, which guardrails fired (and therefore forced a path change), and
    # which explicit exit condition the loop terminated on. This is the part
    # of the architecture that's invisible if you only show agent summaries.
    exit_condition_labels = {
        "auto_resolved": "Auto-resolved (Critic approved, no guardrail blocked)",
        "closed": "Closed (action executed after approval)",
        "pending_human_approval": "Routed to human (guardrail or low confidence)",
        "escalated": "Escalated (guardrail or max turns exceeded)",
    }
    loop_metadata = {
        "turn_count": state.turn_count,
        "max_turns": state.max_turns,
        "max_turns_reached": state.turn_count >= state.max_turns,
        "guardrail_flags": state.guardrail_flags,
        "exit_condition": state.status,
        "exit_condition_label": exit_condition_labels.get(state.status, state.status),
    }

    return {
        "ticket_id": state.ticketId,
        "ticket_number": state.ticket_number,
        "request_type": state.request_type,
        "resolution": resolution_text,
        "confidence": confidence_pct,
        "action_type": action_type,
        "status": ui_status,
        "reasoning_steps": reasoning_steps,
        "sources": sources,
        "loop_metadata": loop_metadata,
    }


@app.post("/api/chat")
async def chat(req: ChatRequest, claims: dict = Depends(verify_token)):
    state = TicketState(
        issue_text=req.message,
        channel=req.channel,
        customer_id=req.user_id,
        max_turns=settings.MAX_TURNS,
    )
    state = await run_pipeline(state)
    return _build_ticket_response(state)


def _verify_email_webhook_secret(x_webhook_secret: str = Header(default="")) -> None:
    """Auth for the Logic App -> backend hop. A Logic App can't complete an
    interactive MSAL login the way the SPA does, so inbound email uses a
    shared secret header instead of an Entra bearer token (the same pattern
    GitHub/Stripe use for webhooks). The Logic App sends this header from a
    secure parameter; never hardcode the real value in the workflow JSON."""
    if not settings.EMAIL_INTAKE_ENABLED:
        raise HTTPException(status_code=404, detail="Email intake is not enabled")
    if not settings.EMAIL_INTAKE_WEBHOOK_SECRET or x_webhook_secret != settings.EMAIL_INTAKE_WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="Invalid or missing webhook secret")


@app.post("/api/email-intake")
async def email_intake(req: EmailIntakeRequest, _: None = Depends(_verify_email_webhook_secret)):
    """Called by the Logic App's 'When a new email arrives' -> HTTP action.
    Runs the exact same agent pipeline as chat (same guardrails, same
    human-in-the-loop rules), then returns a reply-ready payload the Logic
    App's 'Reply to email' action uses to send the response back - ticket
    number included either way, resolution text if auto-resolved, or a
    holding message if it's now sitting in the human approval queue."""
    state = TicketState(
        issue_text=f"{req.subject}\n\n{req.body}".strip(),
        channel="email",
        customer_id=req.from_email,
        max_turns=settings.MAX_TURNS,
    )
    state = await run_pipeline(state)
    result = _build_ticket_response(state)
    result["reply_subject"] = f"Re: {req.subject} [Ticket {state.ticket_number}]"
    return result
