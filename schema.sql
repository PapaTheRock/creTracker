CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint       TEXT PRIMARY KEY,
  p256dh         TEXT,
  auth           TEXT,
  time           TEXT NOT NULL,
  days           TEXT NOT NULL,
  dosage         TEXT NOT NULL DEFAULT '5',
  tz             TEXT NOT NULL DEFAULT 'UTC',
  last_sent_date TEXT,
  created_at     INTEGER NOT NULL
);
