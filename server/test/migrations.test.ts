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

describe('ticket priority and assignment migration', () => {
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
      INSERT INTO tickets (id, key, title, body, status, seq)
      VALUES ('ticket-1', 'DEMO-1', 'Existing ticket', 'Body', 'in_progress', 7);
    `)

    migrate(sql)

    const ticket = sql.database.prepare('SELECT * FROM tickets').get() as Record<string, unknown>
    expect(ticket).toMatchObject({
      id: 'ticket-1',
      key: 'DEMO-1',
      title: 'Existing ticket',
      body: 'Body',
      status: 'in_progress',
      priority: 'none',
      assignee: null,
      seq: 7,
    })
    expect(new Date(String(ticket.created_at)).toISOString()).toBe(ticket.created_at)
    expect(ticket.updated_at).toBe(ticket.created_at)
  })
})
