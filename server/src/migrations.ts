export const LATEST_SCHEMA_VERSION = 2;

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
    role TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'suspended')),
    invited_by TEXT,
    created_at TEXT NOT NULL,
    activated_at TEXT,
    suspended_at TEXT
  );
  CREATE TABLE project_owners (
    project_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    PRIMARY KEY (project_id, member_id)
  );
  CREATE TABLE enrollments (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('invite', 'recovery', 'upgrade')),
    secret_verifier TEXT NOT NULL,
    verifier_key_id TEXT NOT NULL,
    intended_role TEXT,
    intended_access TEXT,
    created_by TEXT,
    created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('human', 'deployment')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    revoked_at TEXT
  );
  CREATE UNIQUE INDEX enrollments_one_live_kind
    ON enrollments (member_id, kind)
    WHERE consumed_at IS NULL AND revoked_at IS NULL;
  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
    name TEXT NOT NULL,
    access TEXT NOT NULL CHECK (access IN ('read', 'write', 'admin')),
    secret_verifier TEXT NOT NULL,
    verifier_key_id TEXT NOT NULL,
    created_by TEXT,
    issued_via TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT,
    CHECK (kind != 'agent' OR access != 'admin')
  );
  CREATE UNIQUE INDEX tokens_one_live_name
    ON tokens (member_id, lower(name))
    WHERE revoked_at IS NULL;
  CREATE TABLE audit_events (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL UNIQUE,
    action TEXT NOT NULL,
    actor_member_id TEXT,
    actor_token_id TEXT,
    actor_kind TEXT NOT NULL,
    agent_name TEXT,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    metadata TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  ALTER TABLE applied_mutations ADD COLUMN actor_member_id TEXT;
  ALTER TABLE applied_mutations ADD COLUMN actor_token_id TEXT;
  ALTER TABLE applied_mutations ADD COLUMN mutation_hash TEXT;
  ALTER TABLE applied_mutations ADD COLUMN stored_result TEXT`,
] as const;

export function runMigrations(sql: SqlStorage, transactionSync: (closure: () => void) => void): void {
  const rawVersion = sql.exec("SELECT value FROM meta WHERE key = 'schema_version'").one().value;
  const version = Number(rawVersion);
  if (!Number.isInteger(version) || version < 0) throw new Error(`invalid schema_version ${rawVersion}`);
  if (version > LATEST_SCHEMA_VERSION) {
    throw new Error(`database schema ${version} is newer than server schema ${LATEST_SCHEMA_VERSION}`);
  }

  for (let index = version; index < MIGRATIONS.length; index += 1) {
    const nextVersion = index + 1;
    transactionSync(() => {
      sql.exec(MIGRATIONS[index]);
      sql.exec("UPDATE meta SET value = ? WHERE key = 'schema_version'", String(nextVersion));
    });
  }
}
