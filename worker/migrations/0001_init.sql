-- Book a Bay schema (docs/API.md, "D1"). Every date/time is shop local: date YYYY-MM-DD, minutes after midnight.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL -- JSON
);

CREATE TABLE requests (
  id              TEXT PRIMARY KEY,
  token           TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('requested', 'confirmed', 'declined', 'offered', 'cancelled')),
  service_id      TEXT NOT NULL,
  service_name    TEXT NOT NULL,
  minutes         INTEGER NOT NULL,
  bays_needed     INTEGER NOT NULL,
  date            TEXT NOT NULL,
  start_min       INTEGER NOT NULL,
  end_min         INTEGER NOT NULL,
  bays            TEXT NOT NULL, -- JSON array of bay numbers
  offer_date      TEXT,
  offer_start_min INTEGER,
  offer_end_min   INTEGER,
  offer_bays      TEXT,
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL,
  year            TEXT NOT NULL DEFAULT '',
  make            TEXT NOT NULL,
  model           TEXT NOT NULL DEFAULT '',
  note            TEXT NOT NULL DEFAULT '',
  shop_note       TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  pushed_at       TEXT
);
CREATE INDEX requests_status_date ON requests (status, date);

-- The race guard. One row per held 15-minute cell per bay; two holds on the same cell cannot both commit.
-- Named indexes (not inline UNIQUE) so the negative control can drop them and show the double booking.
CREATE TABLE cells (
  date  TEXT NOT NULL,
  bay   INTEGER NOT NULL,
  cell  INTEGER NOT NULL, -- minutes after midnight / 15
  owner TEXT NOT NULL     -- r:<request id> or b:<block id>
);
CREATE UNIQUE INDEX cells_unique ON cells (date, bay, cell);
CREATE INDEX cells_owner ON cells (owner);

-- One numbered row per holding request start; n is 1..max_per_slot, so the per-slot cap is also a UNIQUE collision.
CREATE TABLE starts (
  date      TEXT NOT NULL,
  start_min INTEGER NOT NULL,
  n         INTEGER NOT NULL,
  owner     TEXT NOT NULL
);
CREATE UNIQUE INDEX starts_unique ON starts (date, start_min, n);
CREATE INDEX starts_owner ON starts (owner);

CREATE TABLE blocks (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  start_min  INTEGER NOT NULL,
  end_min    INTEGER NOT NULL,
  bays       TEXT NOT NULL, -- JSON array
  label      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX blocks_date ON blocks (date);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, -- SHA-256 hex of the bearer token
  expires_at TEXT NOT NULL
);

CREATE TABLE attempts (
  kind       TEXT NOT NULL, -- 'signin' | 'request'
  key        TEXT NOT NULL, -- client IP
  created_at TEXT NOT NULL
);
CREATE INDEX attempts_kind_key ON attempts (kind, key, created_at);
