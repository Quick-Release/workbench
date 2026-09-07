---
"@quick-release/workbench": minor
---

Session capture (ticket #35): the ingest worker gains an opt-in LLM capture proxy on `/llm/anthropic/` — agents point their provider base URL at the worker, which swaps credentials, relays responses untouched (streamed), and records bodies in a new R2 bucket plus one queryable metadata row per request in D1 (usage parsed server-side, duplicates forward-and-store-once, provider errors relayed verbatim). Authenticated read APIs serve a session index and per-session transcripts; the dashboard gains a session-capture page that renders the conversation redacted at render time with a visible ledger. Onboarding is a provider base-URL swap documented in `worker/README.md`; the R2 bucket and provider key join the alchemy stack.
