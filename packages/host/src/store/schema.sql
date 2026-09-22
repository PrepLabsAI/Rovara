-- Canonical restart state for the local AgentX host.
--
-- Every row that a restart must not lose lives here. Each record keeps its exact
-- validated document in `document`, and repeats only the fields the host queries or
-- conditions a transaction on. Reads re-parse the document through the shipped schema,
-- so a column can never quietly diverge from the contract it mirrors.
--
-- Identifiers that address stored work use COLLATE BINARY. Request identifiers in
-- particular are matched byte for byte: acceptance stores the caller's exact spelling,
-- so two spellings of one UUID are two distinct request identities at every layer.

CREATE TABLE IF NOT EXISTS projects (
  name              TEXT NOT NULL COLLATE BINARY,
  revision          INTEGER NOT NULL,
  document          TEXT NOT NULL,
  registered_by     TEXT NOT NULL COLLATE BINARY,
  registered_at     TEXT NOT NULL,
  PRIMARY KEY (name, revision)
) STRICT;

CREATE TABLE IF NOT EXISTS workspaces (
  id                    TEXT PRIMARY KEY COLLATE BINARY,
  owner_key             TEXT NOT NULL COLLATE BINARY,
  project_name          TEXT NOT NULL COLLATE BINARY,
  project_revision      INTEGER NOT NULL,
  status                TEXT NOT NULL,
  fence                 INTEGER NOT NULL,
  active_operation_id   TEXT COLLATE BINARY,
  document              TEXT NOT NULL,
  updated_at            TEXT NOT NULL
) STRICT;

-- One default workspace per owner and project, enforced by the key rather than by a check.
CREATE TABLE IF NOT EXISTS workspace_defaults (
  owner_key     TEXT NOT NULL COLLATE BINARY,
  project_name  TEXT NOT NULL COLLATE BINARY,
  workspace_id  TEXT NOT NULL COLLATE BINARY REFERENCES workspaces(id),
  PRIMARY KEY (owner_key, project_name)
) STRICT;

CREATE TABLE IF NOT EXISTS conversations (
  workspace_id  TEXT NOT NULL COLLATE BINARY REFERENCES workspaces(id),
  id            TEXT NOT NULL COLLATE BINARY,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS operations (
  id              TEXT PRIMARY KEY COLLATE BINARY,
  workspace_id    TEXT NOT NULL COLLATE BINARY REFERENCES workspaces(id),
  request_id      TEXT NOT NULL COLLATE BINARY,
  payload_hash    TEXT NOT NULL COLLATE BINARY,
  status          TEXT NOT NULL,
  fence           INTEGER NOT NULL,
  document        TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

-- The exact request index. A row here without its operation is an integrity failure,
-- reported as unavailable rather than as absence: "we could not read the index" and
-- "this request was never accepted" are different facts, and only one of them is safe
-- to answer a lost submit reply with.
CREATE TABLE IF NOT EXISTS request_index (
  owner_key     TEXT NOT NULL COLLATE BINARY,
  workspace_id  TEXT NOT NULL COLLATE BINARY,
  request_id    TEXT NOT NULL COLLATE BINARY,
  operation_id  TEXT NOT NULL COLLATE BINARY,
  payload_hash  TEXT NOT NULL COLLATE BINARY,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (owner_key, workspace_id, request_id)
) STRICT;

CREATE TABLE IF NOT EXISTS operation_events (
  operation_id  TEXT NOT NULL COLLATE BINARY REFERENCES operations(id),
  sequence      INTEGER NOT NULL,
  type          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  recorded_at   TEXT NOT NULL,
  PRIMARY KEY (operation_id, sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS artifacts (
  id            TEXT PRIMARY KEY COLLATE BINARY,
  operation_id  TEXT NOT NULL COLLATE BINARY REFERENCES operations(id),
  workspace_id  TEXT NOT NULL COLLATE BINARY REFERENCES workspaces(id),
  name          TEXT NOT NULL COLLATE BINARY,
  media_type    TEXT NOT NULL,
  sha256        TEXT NOT NULL COLLATE BINARY,
  size_bytes    INTEGER NOT NULL,
  -- Stored exactly as the producer sent it. Candidate chunks are base64 and the
  -- workspace diff is plain text; re-encoding either would change its digest.
  content       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (operation_id, name)
) STRICT;

-- Written in the same transaction as the operation it dispatches, so a crash between
-- accepting work and queuing it cannot leave an accepted operation nobody will run.
CREATE TABLE IF NOT EXISTS outbox (
  id            TEXT PRIMARY KEY COLLATE BINARY,
  operation_id  TEXT NOT NULL COLLATE BINARY REFERENCES operations(id),
  workspace_id  TEXT NOT NULL COLLATE BINARY REFERENCES workspaces(id),
  fence         INTEGER NOT NULL,
  invocation    TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  delivered_at  TEXT,
  created_at    TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS operations_by_workspace ON operations (workspace_id, id);
CREATE INDEX IF NOT EXISTS artifacts_by_workspace ON artifacts (workspace_id, id);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (delivered_at, created_at);

-- Execution ownership and uncertainty.
--
-- A dispatched execution is owned by this row before the runtime is touched, so a lost
-- observation has somewhere to be recorded. `unknown` is a hold: the outbox row stays,
-- but nothing may deliver it again until a person or a reconciliation step decides what
-- happened. Silently redelivering would authorize a second execution on the strength of
-- our own ignorance.
CREATE TABLE IF NOT EXISTS executions (
  operation_id  TEXT PRIMARY KEY COLLATE BINARY REFERENCES operations(id),
  execution_id  TEXT NOT NULL COLLATE BINARY,
  state         TEXT NOT NULL,
  reason        TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;

-- Stable effect identity for admitting a run's bytes.
--
-- Re-admitting the identical retained result after a lost reply must be the same effect,
-- not a second one: same operation, no duplicated events, no extra candidate.
CREATE TABLE IF NOT EXISTS admissions (
  effect_id        TEXT PRIMARY KEY COLLATE BINARY,
  operation_id     TEXT NOT NULL COLLATE BINARY REFERENCES operations(id),
  terminal_status  TEXT NOT NULL,
  admitted_at      TEXT NOT NULL
) STRICT;

-- Model-route authority, retained server-side.
--
-- The token handed to a caller is a reference, not the authority itself. Limits, expiry
-- and the whole binding are read back from here at reservation time, so editing a token
-- in flight changes nothing.
CREATE TABLE IF NOT EXISTS model_route_tokens (
  token_id        TEXT PRIMARY KEY COLLATE BINARY,
  operation_id    TEXT NOT NULL COLLATE BINARY,
  case_id         TEXT NOT NULL COLLATE BINARY,
  attempt_number  INTEGER NOT NULL,
  route_version   TEXT NOT NULL COLLATE BINARY,
  policy_digest   TEXT NOT NULL COLLATE BINARY,
  data_class      TEXT NOT NULL COLLATE BINARY,
  model_allowlist TEXT NOT NULL,
  max_microunits  INTEGER NOT NULL,
  max_calls       INTEGER NOT NULL,
  not_after       TEXT NOT NULL,
  issued_at       TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS model_route_reservations (
  reservation_id      TEXT PRIMARY KEY COLLATE BINARY,
  token_id            TEXT NOT NULL COLLATE BINARY REFERENCES model_route_tokens(token_id),
  operation_id        TEXT NOT NULL COLLATE BINARY,
  attempt_number      INTEGER NOT NULL,
  model_id            TEXT NOT NULL COLLATE BINARY,
  route_version       TEXT NOT NULL COLLATE BINARY,
  price_version       TEXT NOT NULL COLLATE BINARY,
  reserved_microunits INTEGER NOT NULL,
  observed_microunits INTEGER,
  state               TEXT NOT NULL,
  reason              TEXT,
  requested_at        TEXT NOT NULL,
  settled_at          TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS model_route_receipts (
  receipt_id      TEXT PRIMARY KEY COLLATE BINARY,
  reservation_id  TEXT NOT NULL COLLATE BINARY REFERENCES model_route_reservations(reservation_id),
  document        TEXT NOT NULL,
  settled_at      TEXT NOT NULL
) STRICT;
