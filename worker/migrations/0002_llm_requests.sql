-- Session capture metadata (ticket #35): one queryable row per proxied LLM
-- request. Bodies live in R2 (request_key/response_key); this table answers
-- usage and health questions without ever reading them. Duplicate request
-- ids never conflict here — a proxy forwards replays and stores once — so
-- the unique index is the dedupe, not a rejection.

CREATE TABLE IF NOT EXISTS llm_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  request_id TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, api_format TEXT,
  status TEXT NOT NULL, http_status INTEGER,
  input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  duration_ms INTEGER, ttft_ms INTEGER,
  request_bytes INTEGER, response_bytes INTEGER,
  request_key TEXT, response_key TEXT, received_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS llm_requests_request_id ON llm_requests (request_id);

CREATE INDEX IF NOT EXISTS llm_requests_session_received ON llm_requests (session_id, received_at);
