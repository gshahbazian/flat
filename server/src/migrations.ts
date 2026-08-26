import { z } from 'zod'

export const LATEST_SCHEMA_VERSION = 3

const storedSchemaVersionSchema = z.union([z.string(), z.number()])
const schemaVersionSchema = storedSchemaVersionSchema
  .transform((value) => Number(value))
  .pipe(z.number().int().nonnegative())

const MIGRATIONS = [
  `CREATE TABLE github_deliveries (
    delivery_id TEXT PRIMARY KEY,
    repository TEXT NOT NULL,
    pull_number INTEGER NOT NULL,
    pull_url TEXT NOT NULL,
    processed_at TEXT NOT NULL,
    results_json TEXT NOT NULL
  )`,
  `CREATE TABLE tenant_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    display_name TEXT NOT NULL,
    initialized_at TEXT NOT NULL
  );
  CREATE TABLE members (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    role TEXT CHECK (role IN ('admin', 'member', 'viewer')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'suspended')),
    invited_by TEXT REFERENCES members(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    activated_at TEXT,
    suspended_at TEXT,
    CHECK ((status = 'pending' AND role IS NULL AND activated_at IS NULL)
      OR (status != 'pending' AND role IS NOT NULL AND activated_at IS NOT NULL))
  );
  CREATE TABLE project_owners (
    project_id TEXT NOT NULL,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES members(id),
    PRIMARY KEY (project_id, member_id)
  );
  CREATE TABLE enrollments (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('invite', 'recovery', 'upgrade')),
    secret_verifier TEXT NOT NULL,
    verifier_key_id TEXT NOT NULL,
    intended_role TEXT CHECK (intended_role IN ('admin', 'member', 'viewer')),
    intended_access TEXT CHECK (intended_access IN ('read', 'write', 'admin')),
    created_by TEXT REFERENCES members(id),
    created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('human', 'deployment')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    revoked_at TEXT,
    CHECK ((kind = 'invite' AND intended_role IS NOT NULL AND intended_access IS NULL)
      OR (kind = 'recovery' AND intended_role IS NULL AND intended_access IS NULL)
      OR (kind = 'upgrade' AND intended_role IS NULL AND intended_access IS NOT NULL)),
    CHECK ((created_by_kind = 'deployment' AND created_by IS NULL)
      OR (created_by_kind = 'human' AND created_by IS NOT NULL))
  );
  CREATE UNIQUE INDEX enrollments_one_live_kind
    ON enrollments (member_id, kind)
    WHERE consumed_at IS NULL AND revoked_at IS NULL;
  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
    name TEXT NOT NULL,
    access TEXT NOT NULL CHECK (access IN ('read', 'write', 'admin')),
    secret_verifier TEXT NOT NULL,
    verifier_key_id TEXT NOT NULL,
    created_by TEXT REFERENCES members(id),
    issued_via TEXT NOT NULL CHECK (issued_via IN ('setup', 'invite', 'recovery', 'self', 'admin_delegation')),
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT,
    CHECK (kind != 'agent' OR access != 'admin'),
    CHECK (length(name) BETWEEN 1 AND 64
      AND substr(name, 1, 1) GLOB '[A-Za-z0-9]'
      AND name NOT GLOB '*[^A-Za-z0-9._-]*'),
    CHECK (kind != 'agent' OR expires_at IS NOT NULL)
  );
  CREATE UNIQUE INDEX tokens_one_live_name
    ON tokens (member_id, lower(name))
    WHERE revoked_at IS NULL;
  CREATE TABLE audit_events (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL UNIQUE,
    action TEXT NOT NULL,
    actor_member_id TEXT REFERENCES members(id),
    actor_token_id TEXT REFERENCES tokens(id),
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'enrollment', 'deployment', 'webhook')),
    agent_name TEXT,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    metadata TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK ((actor_kind IN ('human', 'agent') AND actor_member_id IS NOT NULL AND actor_token_id IS NOT NULL)
      OR (actor_kind NOT IN ('human', 'agent') AND actor_member_id IS NULL AND actor_token_id IS NULL)),
    CHECK ((actor_kind = 'agent' AND agent_name IS NOT NULL)
      OR (actor_kind != 'agent' AND agent_name IS NULL))
  );
  ALTER TABLE applied_mutations ADD COLUMN actor_member_id TEXT;
  ALTER TABLE applied_mutations ADD COLUMN actor_token_id TEXT;
  ALTER TABLE applied_mutations ADD COLUMN mutation_hash TEXT;
  ALTER TABLE applied_mutations ADD COLUMN stored_result TEXT`,
  `CREATE TABLE ticket_tombstones (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    seq INTEGER NOT NULL UNIQUE CHECK (seq >= 0)
  )`,
] as const

export function runMigrations(
  sql: SqlStorage,
  transactionSync: (closure: () => void) => void
): void {
  const rawVersion = sql.exec("SELECT value FROM meta WHERE key = 'schema_version'").one().value
  const storedVersion = storedSchemaVersionSchema.safeParse(rawVersion)
  if (!storedVersion.success) {
    throw new Error('invalid schema_version')
  }
  const parsedVersion = schemaVersionSchema.safeParse(storedVersion.data)
  if (!parsedVersion.success) {
    throw new Error(`invalid schema_version ${storedVersion.data}`)
  }
  const version = parsedVersion.data
  if (version > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `database schema ${version} is newer than server schema ${LATEST_SCHEMA_VERSION}`
    )
  }

  for (let index = version; index < MIGRATIONS.length; index += 1) {
    const nextVersion = index + 1
    transactionSync(() => {
      sql.exec(MIGRATIONS[index])
      sql.exec("UPDATE meta SET value = ? WHERE key = 'schema_version'", String(nextVersion))
    })
  }
}
