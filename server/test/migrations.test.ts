import { DatabaseSync } from 'node:sqlite'

import { describe, expect, test } from 'vitest'

import { LATEST_SCHEMA_VERSION, runMigrations } from '../src/migrations'

class TestSql {
  constructor(readonly database = new DatabaseSync(':memory:')) {}

  exec<T extends Record<string, ArrayBuffer | string | number | null>>(
    query: string,
    ...bindings: Array<string | number | null>
  ) {
    const returnsRows = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(query)
    if (returnsRows) {
      const rows = this.database.prepare(query).all(...bindings) as T[]
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`)
          return rows[0]
        },
      }
    }

    if (bindings.length > 0) {
      this.database.prepare(query).run(...bindings)
    } else {
      this.database.exec(query)
    }
    return {
      toArray: () => [] as T[],
      one: () => {
        throw new Error('statement returned no rows')
      },
    }
  }

  transactionSync(closure: () => void): void {
    this.database.exec('BEGIN')
    try {
      closure()
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

function baseDatabase(version: number): TestSql {
  const sql = new TestSql()
  sql.database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta (key, value) VALUES ('schema_version', '${version}');
    INSERT INTO meta (key, value) VALUES ('project_key', 'DEMO');
    INSERT INTO meta (key, value) VALUES ('next_ticket_num', '1');
    INSERT INTO meta (key, value) VALUES ('latest_seq', '0');
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      seq INTEGER NOT NULL
    );
    CREATE TABLE applied_mutations (
      mutation_id TEXT PRIMARY KEY,
      result TEXT NOT NULL
    );
  `)
  return sql
}

function migrate(sql: TestSql): void {
  runMigrations(sql, (closure) => sql.transactionSync(closure))
}

describe('ordered database migrations', () => {
  test('fresh database reaches the latest schema', () => {
    const sql = baseDatabase(0)
    migrate(sql)

    const version = sql.database
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string }
    expect(Number(version.value)).toBe(LATEST_SCHEMA_VERSION)
    const columns = sql.database.prepare('PRAGMA table_info(tickets)').all() as Array<{
      name: string
      notnull: number
    }>
    expect(columns.map((column) => column.name)).toEqual([
      'id',
      'key',
      'project',
      'title',
      'body',
      'status',
      'priority',
      'assignee',
      'created_at',
      'updated_at',
      'seq',
    ])
    expect(columns.find((column) => column.name === 'priority')?.notnull).toBe(1)
  })

  test('version-3 tickets survive with safe defaults and timestamps', () => {
    const sql = baseDatabase(3)
    sql.database.exec(`
      CREATE TABLE members (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        role TEXT,
        status TEXT NOT NULL,
        invited_by TEXT,
        created_at TEXT NOT NULL,
        activated_at TEXT,
        suspended_at TEXT
      );
      CREATE TABLE tenant_metadata (
        singleton INTEGER PRIMARY KEY,
        display_name TEXT NOT NULL,
        initialized_at TEXT NOT NULL
      );
      CREATE TABLE project_owners (
        project_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        PRIMARY KEY (project_id, member_id)
      );
      INSERT INTO tenant_metadata (singleton, display_name, initialized_at)
      VALUES (1, 'Migrated tenant', '2026-08-01T10:00:00.000Z');
      INSERT INTO members
        (id, email, role, status, invited_by, created_at, activated_at, suspended_at)
      VALUES ('admin-1', 'admin@example.com', 'admin', 'active', NULL,
        '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z', NULL);
      INSERT INTO tickets (id, key, title, body, status, seq)
      VALUES ('ticket-1', 'DEMO-1', 'Existing ticket', 'Body', 'in_progress', 7);
      UPDATE meta SET value = '2' WHERE key = 'next_ticket_num';
    `)

    migrate(sql)

    const ticket = sql.database.prepare('SELECT * FROM tickets').get() as Record<string, unknown>
    expect(ticket).toMatchObject({
      id: 'ticket-1',
      key: 'DEMO-1',
      project: '00000000000000000000000000',
      title: 'Existing ticket',
      body: 'Body',
      status: 'in_progress',
      priority: 'none',
      assignee: null,
      seq: 7,
    })
    expect(new Date(String(ticket.created_at)).toISOString()).toBe(ticket.created_at)
    expect(ticket.updated_at).toBe(ticket.created_at)
    expect(sql.database.prepare('SELECT key, next_ticket_num FROM projects').get()).toEqual({
      key: 'DEMO',
      next_ticket_num: 2,
    })
    expect(sql.database.prepare('SELECT project_id, member_id FROM project_owners').get()).toEqual({
      project_id: '00000000000000000000000000',
      member_id: 'admin-1',
    })
  })
})
