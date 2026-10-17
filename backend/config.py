"""
Central config - reads every Azure connection value from env vars.
Nothing is hardcoded so the same code runs locally (.env) and in the
Container App (env vars injected via managed identity / secrets in Phase 7).
"""
import os


class Settings:
    # Azure OpenAI
    AOAI_ENDPOINT = os.environ["AZURE_OPENAI_ENDPOINT"]
    AOAI_API_KEY = os.environ["AZURE_OPENAI_API_KEY"]
    AOAI_API_VERSION = os.environ.get("AZURE_OPENAI_API_VERSION", "2024-10-21")
    MINI_DEPLOYMENT = os.environ.get("AZURE_OPENAI_MINI_DEPLOYMENT", "intake-triage-model")  # intake/triage
    FLAGSHIP_DEPLOYMENT = os.environ.get("AZURE_OPENAI_FLAGSHIP_DEPLOYMENT", "resolver-critic-model")
    EMBED_DEPLOYMENT = os.environ.get("AZURE_OPENAI_EMBED_DEPLOYMENT", "text-embedding")

    # Azure AI Search
    SEARCH_ENDPOINT = os.environ["AZURE_SEARCH_ENDPOINT"]
    SEARCH_ADMIN_KEY = os.environ["AZURE_SEARCH_ADMIN_KEY"]
    SEARCH_INDEX = os.environ.get("AZURE_SEARCH_INDEX", "support-kb-index")

    # Cosmos DB
    COSMOS_ENDPOINT = os.environ["COSMOS_ENDPOINT"]
    COSMOS_KEY = os.environ["COSMOS_KEY"]
    COSMOS_DB = os.environ.get("COSMOS_DB", "supportdesk")
    COSMOS_TICKETS_CONTAINER = os.environ.get("COSMOS_TICKETS_CONTAINER", "tickets")
    COSMOS_AUDIT_CONTAINER = os.environ.get("COSMOS_AUDIT_CONTAINER", "auditLog")

    # Loop engineering knobs
    MAX_TURNS = int(os.environ.get("MAX_TURNS", "6"))
    RAG_CONFIDENCE_THRESHOLD = float(os.environ.get("RAG_CONFIDENCE_THRESHOLD", "0.45"))
    # Hard floor: below this, the ticket always goes to a human, regardless of
    # what the Critic itself decides. 0.50 = "below 50% confidence -> human."
    AUTO_RESOLVE_CONFIDENCE_THRESHOLD = float(os.environ.get("AUTO_RESOLVE_CONFIDENCE_THRESHOLD", "0.50"))
    # The Resolver Agent is the one genuinely agentic step in the pipeline -
    # it can call search_kb / get_customer_history itself, as many times as it
    # decides it needs, instead of running a fixed number of steps. This caps
    # that loop so a confused model can't spin forever - same exit-condition
    # idea as MAX_TURNS above, just scoped to one agent's tool-calling loop.
    RESOLVER_MAX_TOOL_CALLS = int(os.environ.get("RESOLVER_MAX_TOOL_CALLS", "4"))

    # Cost optimization: skip the Resolver's (flagship-model) LLM call entirely
    # on a repeat issue. Keyed on the top RAG citation id rather than the raw
    # issue text, since two different phrasings of the same problem (e.g.
    # "camera won't turn on" vs "camera not working") already retrieve the
    # same KB doc via vector search - so this generalizes across wording for
    # free, using a signal the pipeline already computes. Critic still
    # reviews every ticket, cached or not - only the drafting call is skipped.
    RESOLVER_CACHE_ENABLED = os.environ.get("RESOLVER_CACHE_ENABLED", "true").lower() == "true"
    RESOLVER_CACHE_TTL_SECONDS = int(os.environ.get("RESOLVER_CACHE_TTL_SECONDS", "86400"))  # 24h
    RESOLVER_CACHE_MAX_ENTRIES = int(os.environ.get("RESOLVER_CACHE_MAX_ENTRIES", "500"))
    # Only reuse a cached answer if the RAG match that produced it (and the
    # match for the new ticket) was strong - never replay a cached answer
    # that came from a shaky/ambiguous KB match.
    # 0.55, not 0.75: pure-vector cosine scores for short, correct queries land
    # in the 0.6s (a real "camera issues" ticket matched its exact KB article at
    # 0.64), so 0.75 meant common questions never got cached. Keep this above
    # RAG_CONFIDENCE_THRESHOLD (0.45) so weak matches are still never replayed.
    RESOLVER_CACHE_MIN_RAG_CONFIDENCE = float(os.environ.get("RESOLVER_CACHE_MIN_RAG_CONFIDENCE", "0.55"))

    # Question-level cache (question_cache.py): skips the Intake and Triage
    # LLM calls for an exact repeat of a question that already ended in a clean
    # auto-resolve on an "auto_resolve"-tagged KB article. RAG, Resolver and
    # Critic still run, so no guardrail or human-review rule is bypassed.
    QUESTION_CACHE_ENABLED = os.environ.get("QUESTION_CACHE_ENABLED", "true").lower() == "true"
    QUESTION_CACHE_TTL_SECONDS = int(os.environ.get("QUESTION_CACHE_TTL_SECONDS", "86400"))  # 24h
    QUESTION_CACHE_MAX_ENTRIES = int(os.environ.get("QUESTION_CACHE_MAX_ENTRIES", "500"))

    # Cost tracing: $ per 1,000 tokens, by service_id. Defaults match the
    # models actually deployed on this rebuild - GPT-4.1-mini (mini) and
    # GPT-4o (flagship). If your deployment ever changes model again, update
    # these (or override via env vars) so the estimated costs in the trace
    # stay accurate instead of just plausible-looking.
    TOKEN_PRICING = {
        "mini": {
            "input": float(os.environ.get("MINI_INPUT_PRICE_PER_1K", "0.0004")),
            "output": float(os.environ.get("MINI_OUTPUT_PRICE_PER_1K", "0.0016")),
        },
        "flagship": {
            "input": float(os.environ.get("FLAGSHIP_INPUT_PRICE_PER_1K", "0.0025")),
            "output": float(os.environ.get("FLAGSHIP_OUTPUT_PRICE_PER_1K", "0.01")),
        },
    }

    # CORS - config-driven base URL, frontend origin allowed to call this API
    ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")

    # Entra ID auth - disabled by default so existing deployments keep working
    # until the env vars below are set and this is explicitly turned on.
    ENTRA_AUTH_ENABLED = os.environ.get("ENTRA_AUTH_ENABLED", "false").lower() == "true"
    ENTRA_TENANT_ID = os.environ.get("ENTRA_TENANT_ID", "")
    ENTRA_BACKEND_CLIENT_ID = os.environ.get("ENTRA_BACKEND_CLIENT_ID", "")

    # Monitoring - App Insights connection string. Empty by default so local
    # dev / early deploys don't need it; monitoring turns on the moment it's set.
    APPLICATIONINSIGHTS_CONNECTION_STRING = os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING", "")

    # Email channel - a Logic App (Office 365 Outlook connector on a real
    # mailbox) posts inbound mail here and relays the reply back out. This is
    # a machine-to-machine webhook (the Logic App can't do an interactive
    # MSAL sign-in like the SPA does), so it's authenticated with a shared
    # secret instead of an Entra bearer token - same pattern as GitHub/Stripe
    # webhooks. Disabled by default until the secret is set.
    EMAIL_INTAKE_ENABLED = os.environ.get("EMAIL_INTAKE_ENABLED", "false").lower() == "true"
    EMAIL_INTAKE_WEBHOOK_SECRET = os.environ.get("EMAIL_INTAKE_WEBHOOK_SECRET", "")


settings = Settings()
