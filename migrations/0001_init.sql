CREATE TABLE asks (
  id TEXT PRIMARY KEY,              -- public, 16 chars, goes in the human link
  token_hash TEXT NOT NULL,         -- sha256 of agent token (sq_...)
  kind TEXT NOT NULL,               -- photo | location | choice | text
  ask TEXT NOT NULL,                -- what the agent wants, shown to the human
  spec TEXT NOT NULL DEFAULT '{}',  -- JSON: extract{}, options[], hint
  status TEXT NOT NULL DEFAULT 'pending', -- pending | opened | done | expired | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  attempt_log TEXT NOT NULL DEFAULT '[]', -- JSON [{n, ok, issue, at}]
  result TEXT,                      -- JSON typed result once done
  callback_url TEXT,
  callback_state TEXT,              -- null | sent | failed
  image_tokens_spared INTEGER NOT NULL DEFAULT 0,
  ip_hash TEXT,
  created_at INTEGER NOT NULL,
  opened_at INTEGER,
  done_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX asks_expires ON asks(expires_at);
CREATE TABLE rate_limits (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
