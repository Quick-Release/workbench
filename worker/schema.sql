-- Workbench ingest store (ADR 0001). Two data products, two tables:
-- Telemetry (mandatory usage reporting) and Submissions (consent-gated
-- content sourcing). Marketing reads submissions with SQL; status starts
-- 'pending' and is owned by the review side, never by this endpoint.

CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key TEXT NOT NULL,
  day TEXT NOT NULL,
  repo_remote TEXT NOT NULL,
  developer_login TEXT,
  developer_email TEXT,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS telemetry_dedup ON telemetry (dedup_key);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_remote TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  developer_login TEXT,
  developer_email TEXT,
  ticket_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_at TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS submissions_repo_sha ON submissions (repo_remote, commit_sha);
