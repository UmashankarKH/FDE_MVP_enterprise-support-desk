"""
One Semantic Kernel instance, two registered chat services:
  "mini"     -> cheap/fast model, used by Intake + Triage (high volume, low complexity)
  "flagship" -> stronger model, used by Resolver + Critic (reasoning-heavy, must be careful)
Agents ask for a service by id rather than hardcoding a model, so swapping
models later (or live-swapping to Gemini for the multi-cloud demo) is a
one-line config change, not a code change.
"""
import json
import logging

from openai import AsyncAzureOpenAI
from semantic_kernel import Kernel
from semantic_kernel.connectors.ai.function_choice_behavior import FunctionChoiceBehavior
from semantic_kernel.connectors.ai.open_ai import AzureChatCompletion
from semantic_kernel.contents.chat_history import ChatHistory
from semantic_kernel.contents.utils.author_role import AuthorRole
from semantic_kernel.connectors.ai.open_ai import AzureChatPromptExecutionSettings

from config import settings

logger = logging.getLogger("kernel")

kernel = Kernel()

# Build our own AsyncAzureOpenAI client with the exact endpoint/key/api-version
# combo already confirmed working (same one the RAG ingestion script used), and
# hand it to SK directly instead of letting SK's connector build its own URL/
# version - avoids version drift between what SK defaults to internally and
# what this specific resource actually supports.
_shared_async_client = AsyncAzureOpenAI(
    azure_endpoint=settings.AOAI_ENDPOINT,
    api_key=settings.AOAI_API_KEY,
    api_version=settings.AOAI_API_VERSION,
)

kernel.add_service(
    AzureChatCompletion(
        service_id="mini",
        deployment_name=settings.MINI_DEPLOYMENT,
        async_client=_shared_async_client,
    )
)

kernel.add_service(
    AzureChatCompletion(
        service_id="flagship",
        deployment_name=settings.FLAGSHIP_DEPLOYMENT,
        async_client=_shared_async_client,
    )
)

# The Resolver Agent's tools (search_kb, get_customer_history) - registered
# once, here, so both this module and resolver_agent.py share the same
# kernel/plugin instance. Imported lazily inside a function (not at module
# top-level) only to keep this file's import order simple to reason about;
# agents/resolver_tools.py itself has no dependency back on this module, so
# there's no circular-import risk either way.
from agents.resolver_tools import ResolverTools  # noqa: E402

kernel.add_plugin(ResolverTools(), plugin_name="resolver_tools")


def _sum_usage(history: ChatHistory) -> tuple[int, int]:
    """Sums prompt/completion tokens across every assistant turn in this
    exchange, not just the final reply. Matters most for run_agent_with_tools:
    a single Resolver call can involve several real model round-trips (one
    per tool call), each with its own token cost - reading only the last
    response's usage would silently under-count the true cost of that turn."""
    prompt_tokens = 0
    completion_tokens = 0
    for msg in history.messages:
        if msg.role != AuthorRole.ASSISTANT:
            continue
        usage = (msg.metadata or {}).get("usage")
        if usage is not None:
            prompt_tokens += usage.prompt_tokens or 0
            completion_tokens += usage.completion_tokens or 0
    return prompt_tokens, completion_tokens


def _estimate_cost_usd(service_id: str, prompt_tokens: int, completion_tokens: int) -> float:
    prices = settings.TOKEN_PRICING.get(service_id, {"input": 0.0, "output": 0.0})
    cost = (prompt_tokens / 1000) * prices["input"] + (completion_tokens / 1000) * prices["output"]
    return round(cost, 6)


def _record_usage(state, service_id: str, agent_label: str, history: ChatHistory) -> None:
    """Appends one usage/cost entry to the ticket state, if a state object
    was passed in. Silently does nothing otherwise - callers that don't care
    about tracing (or don't have a state on hand) aren't forced to opt in."""
    if state is None:
        return
    prompt_tokens, completion_tokens = _sum_usage(history)
    cost = _estimate_cost_usd(service_id, prompt_tokens, completion_tokens)
    state.token_usage.append({
        "agent": agent_label or service_id,
        "service_id": service_id,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
        "estimated_cost_usd": cost,
    })
    state.total_cost_usd = round(state.total_cost_usd + cost, 6)


async def run_agent(service_id: str, system_prompt: str, user_prompt: str,
                     temperature: float = 0.2, expect_json: bool = True,
                     max_tokens: int = 800, state=None, agent_label: str | None = None) -> dict | str:
    """Call one of the two registered models and (optionally) parse JSON out of the reply.
    max_tokens defaults high (Resolver needs room to draft real customer text) but
    Intake/Triage/Critic only return short JSON verdicts - they pass a much lower
    cap, which directly cuts generation latency since output length is the main
    driver of per-call time for autoregressive models."""
    service = kernel.get_service(service_id)
    history = ChatHistory()
    history.add_system_message(system_prompt)
    history.add_user_message(user_prompt)

    settings_exec = AzureChatPromptExecutionSettings(temperature=temperature, max_tokens=max_tokens)
    response = await service.get_chat_message_content(chat_history=history, settings=settings_exec)
    history.add_message(response)  # so _record_usage can see this turn's usage metadata
    text = str(response)

    _record_usage(state, service_id, agent_label, history)

    if not expect_json:
        return text

    try: 
        start = text.index("{")
        end = text.rindex("}") + 1
        return json.loads(text[start:end])
    except (ValueError, json.JSONDecodeError) as e:
        logger.warning("Model did not return valid JSON, wrapping raw text. Error: %s", e)
        return {"raw_text": text, "parse_error": str(e)}


async def run_agent_with_tools(
    service_id: str,
    system_prompt: str,
    user_prompt: str,
    plugin_name: str,
    temperature: float = 0.2,
    max_tokens: int = 800,
    max_tool_calls: int = 4,
    state=None,
    agent_label: str | None = None,
) -> tuple[dict | str, list[str]]:
    """Same contract as run_agent (parses JSON out of the final reply), except
    the model is handed a specific plugin's tools and allowed to call them
    itself, zero or more times, before answering - this is the one place in
    the pipeline that's a real agent loop rather than a single structured
    call. Everything else about the surrounding pipeline (who calls this,
    what happens to the result, the guardrails downstream) is unchanged.

    Returns (parsed_result, tool_calls_made) - the second value is just the
    list of tool names the model actually invoked, for logging/the reasoning
    trace. Kept in its own function rather than folded into run_agent so the
    four agents already working (Intake/Triage/Critic/plain Resolver calls)
    are untouched by this change."""
    service = kernel.get_service(service_id)
    history = ChatHistory()
    history.add_system_message(system_prompt)
    history.add_user_message(user_prompt)

    settings_exec = AzureChatPromptExecutionSettings(
        temperature=temperature,
        max_tokens=max_tokens,
        function_choice_behavior=FunctionChoiceBehavior.Auto(
            auto_invoke=True,
            maximum_auto_invoke_attempts=max_tool_calls,
            filters={"included_plugins": [plugin_name]},
        ),
    )

    response = await service.get_chat_message_content(
        chat_history=history,
        settings=settings_exec,
        kernel=kernel,
    )
    # SK only auto-appends the *intermediate* tool-calling rounds to history
    # internally (each one that requested a function call) - the final round
    # (the one actually returned here) is never added on its own. Add it
    # manually so _record_usage's per-turn scan below sees every real model
    # round-trip this call made, not just the earlier ones.
    history.add_message(response)
    text = str(response)

    _record_usage(state, service_id, agent_label, history)

    # Best-effort read of which tools actually got called, purely for the
    # trace/dashboard - if SK's internal message shape ever shifts, this
    # should degrade to an empty list rather than break the resolver.
    tool_calls_made: list[str] = []
    try:
        for msg in history.messages:
            if msg.role != AuthorRole.TOOL:
                continue
            for item in msg.items:
                fn_name = getattr(item, "function_name", None)
                if fn_name:
                    tool_calls_made.append(fn_name)
    except Exception as e:  # noqa: BLE001
        logger.warning("Could not extract tool-call trace: %s", e)

    try:
        start = text.index("{")
        end = text.rindex("}") + 1
        return json.loads(text[start:end]), tool_calls_made
    except (ValueError, json.JSONDecodeError) as e:
        logger.warning("Model did not return valid JSON, wrapping raw text. Error: %s", e)
        return {"raw_text": text, "parse_error": str(e)}, tool_calls_made
