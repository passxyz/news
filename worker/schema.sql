-- ============================================================
-- CyberSec Daily — optional D1 schema (Phase P6-3)
-- ============================================================
-- KV is the PRIMARY store used by the Worker at runtime.
-- This D1 schema is provided as an alternative for operators who
-- prefer a relational store with SQL queries / migrations. To use it:
--   1) Create a D1 database: `wrangler d1 create cybersec-news`
--   2) Add a [[d1_databases]] binding (commented in wrangler.toml).
--   3) Apply this schema: `wrangler d1 execute cybersec-news --file=worker/schema.sql`
--   4) Swap the KV reads/writes in src/index.ts for D1 prepared statements.
-- ============================================================

-- Subscriber records (mirrors the KV value shape).
-- status: 'pending' | 'active' | 'inactive'
CREATE TABLE IF NOT EXISTS subscribers (
  email          TEXT PRIMARY KEY,           -- lowercased email
  status         TEXT NOT NULL DEFAULT 'pending',
  confirm_token  TEXT NOT NULL UNIQUE,        -- shared token for confirm + unsubscribe
  lang           TEXT NOT NULL DEFAULT 'en',
  created_at     TEXT NOT NULL,               -- ISO-8601 timestamp
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers (status);
CREATE INDEX IF NOT EXISTS idx_subscribers_token  ON subscribers (confirm_token);

-- Source list mirror (single row holding the JSON array, key = 'sources').
CREATE TABLE IF NOT EXISTS kv_mirror (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Simple sliding-window rate limit counters (alternative to the
-- RATE_LIMIT KV namespace). Each row is a (bucket, ip) counter with
-- an absolute expiration timestamp.
CREATE TABLE IF NOT EXISTS rate_limit (
  bucket    TEXT NOT NULL,                    -- e.g. 'subscribe' or 'send-daily'
  ip        TEXT NOT NULL,
  window    INTEGER NOT NULL,                 -- epoch seconds of the window start
  count     INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,                -- epoch seconds
  PRIMARY KEY (bucket, ip, window)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_expires ON rate_limit (expires_at);
