-- Snow Route schema. Instants are ISO 8601 UTC text (toISOString), so they sort and compare as text. Money is integer cents.

-- One deployment = one contractor: exactly one company row.
CREATE TABLE company (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/St_Johns',
  yard_label TEXT NOT NULL,
  yard_lat REAL NOT NULL,
  yard_lng REAL NOT NULL,
  pin TEXT NOT NULL -- JSON {alg, iterations, salt, hash}: PBKDF2-SHA256
);

-- Owner sessions: only the SHA-256 of the token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Rate guards: kind 'pin' (wrong PIN) or 'status' (unknown status key), per IP.
CREATE TABLE signin_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ip TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX signin_attempts_by_ip ON signin_attempts (kind, ip, at);

CREATE TABLE trucks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  driver_key TEXT NOT NULL UNIQUE
);

CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('driveway', 'lot', 'walkway')),
  priority TEXT NOT NULL CHECK (priority IN ('medical', 'commuter', 'business', 'none')),
  opens_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  billing TEXT NOT NULL CHECK (billing IN ('per_push', 'seasonal')),
  price_cents INTEGER NOT NULL,
  truck_id INTEGER REFERENCES trucks (id),
  active INTEGER NOT NULL DEFAULT 1,
  status_key TEXT NOT NULL UNIQUE
);

CREATE TABLE storms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
-- At most one active storm, enforced by the database (two owners tapping Start at once get one storm and one 409).
CREATE UNIQUE INDEX storms_one_active ON storms ((ended_at IS NULL)) WHERE ended_at IS NULL;

-- The trucks out in a storm (a truck can be in a storm with no stops).
CREATE TABLE storm_trucks (
  storm_id INTEGER NOT NULL REFERENCES storms (id),
  truck_id INTEGER NOT NULL REFERENCES trucks (id),
  PRIMARY KEY (storm_id, truck_id)
);

CREATE TABLE storm_stops (
  storm_id INTEGER NOT NULL REFERENCES storms (id),
  client_id INTEGER NOT NULL REFERENCES clients (id),
  truck_id INTEGER NOT NULL REFERENCES trucks (id),
  position INTEGER NOT NULL,
  PRIMARY KEY (storm_id, client_id)
);

-- A check-in id is the phone's UUID: the idempotency key that makes resending safe.
CREATE TABLE checkins (
  id TEXT PRIMARY KEY,
  storm_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  truck_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('plowed', 'skipped')),
  reason TEXT,
  note TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  at_adjusted INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  has_photo INTEGER NOT NULL DEFAULT 0,
  voided_at TEXT
);
CREATE INDEX checkins_by_stop ON checkins (storm_id, client_id);
CREATE INDEX checkins_by_at ON checkins (kind, at);
-- One plowed check-in per client per storm (DECISIONS.md 7).
CREATE UNIQUE INDEX checkins_one_plowed ON checkins (storm_id, client_id) WHERE kind = 'plowed' AND voided_at IS NULL;

-- Photo bytes live in R2 under checkins/<checkin_id>; this row holds the unguessable token the photo URL uses.
CREATE TABLE photos (
  checkin_id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  stored_at TEXT NOT NULL
);
