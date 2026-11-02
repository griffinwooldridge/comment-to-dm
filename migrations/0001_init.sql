-- One row per person, post and keyword. The primary key is what stops duplicate DMs.
CREATE TABLE deliveries (
  dedupe_key TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  commenter_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Keywords already emailed about, so each new reel only alerts once.
CREATE TABLE flagged_keywords (
  keyword TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
