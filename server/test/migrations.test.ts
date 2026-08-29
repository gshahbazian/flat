import { DatabaseSync } from 'node:sqlite'

import { describe, expect, test } from 'vitest'
import { z } from 'zod'

import { LATEST_SCHEMA_VERSION, rebuildTicketSearch, runMigrations } from '../src/migrations'
import { jsonObjectSchema } from '../src/request-schema'

class TestSql {
  constructor(readonly database = new DatabaseSync(':memory:')) {}

  exec<T extends Record<string, ArrayBuffer | string | number | null>>(
    query: string,
    ...bindings: Array<string | number | null>
  ) {
    const returnsRows = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(query)
    if (returnsRows) {
      // SAFETY: The selected columns define T, and each test creates the matching SQLite schema.
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
    // SAFETY: A statement that returns no rows has an empty result for every row type T.
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

    // SAFETY: The meta schema requires value to be text for this selected row.
    const version = sql.database
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string }
    expect(Number(version.value)).toBe(LATEST_SCHEMA_VERSION)
    // SAFETY: SQLite's table_info pragma guarantees these columns and value types.
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
    // SAFETY: SQLite's table_info pragma guarantees the name column is text.
    const commentColumns = sql.database.prepare('PRAGMA table_info(comments)').all() as Array<{
      name: string
    }>
    expect(commentColumns.map((column) => column.name)).toEqual([
      'id',
      'ticket_id',
      'body',
      'member_id',
      'token_id',
      'token_kind',
      'agent_name',
      'delegating_member_id',
      'created_at',
      'seq',
    ])
    // SAFETY: SQLite's foreign_key_list pragma guarantees these columns are text.
    const foreignKeys = sql.database.prepare('PRAGMA foreign_key_list(comments)').all() as Array<{
      table: string
      from: string
      on_delete: string
    }>
    expect(foreignKeys).toContainEqual(
      expect.objectContaining({ table: 'tickets', from: 'ticket_id', on_delete: 'CASCADE' })
    )
    // SAFETY: SQLite's table_info pragma guarantees the name column is text.
    const searchColumns = sql.database.prepare('PRAGMA table_info(ticket_search)').all() as Array<{
      name: string
    }>
    expect(searchColumns.map((column) => column.name)).toEqual([
      'ticket_id',
      'source_kind',
      'source_id',
      'title',
      'description',
      'comment',
    ])
    // SAFETY: SQLite's table_info pragma guarantees the name column is text.
    const labelColumns = sql.database.prepare('PRAGMA table_info(labels)').all() as Array<{
      name: string
    }>
    expect(labelColumns.map((column) => column.name)).toEqual([
      'id',
      'name',
      'created_at',
      'updated_at',
      'seq',
    ])
    // SAFETY: SQLite's foreign_key_list pragma guarantees these columns are text.
    const membershipForeignKeys = sql.database
      .prepare('PRAGMA foreign_key_list(ticket_labels)')
      .all() as Array<{ table: string; from: string; on_delete: string }>
    expect(membershipForeignKeys).toContainEqual(
      expect.objectContaining({ table: 'tickets', from: 'ticket_id', on_delete: 'CASCADE' })
    )
    expect(membershipForeignKeys).toContainEqual(
      expect.objectContaining({ table: 'labels', from: 'label_id', on_delete: 'CASCADE' })
    )
  })

  test('search migration backfills and rebuilds ticket and comment documents', () => {
    const sql = baseDatabase(0)
    migrate(sql)
    sql.database.exec(`
      DROP TRIGGER ticket_search_ticket_insert;
      DROP TRIGGER ticket_search_ticket_update;
      DROP TRIGGER ticket_search_comment_insert;
      DROP TRIGGER ticket_search_ticket_delete;
      DROP TABLE ticket_search;
      DROP TABLE ticket_labels;
      DROP TABLE label_tombstones;
      DROP TABLE label_name_reservations;
      DROP TABLE labels;
      UPDATE meta SET value = '6' WHERE key = 'schema_version';
      INSERT INTO tenant_metadata (singleton, display_name, initialized_at)
      VALUES (1, 'Tenant', '2026-08-01T00:00:00.000Z');
      INSERT INTO members
        (id, email, role, status, invited_by, created_at, activated_at, suspended_at)
      VALUES ('member-1', 'member@example.com', 'admin', 'active', NULL,
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL);
      INSERT INTO tokens
        (id, member_id, kind, name, access, secret_verifier, verifier_key_id, created_by,
         issued_via, created_at, expires_at, last_used_at, revoked_at)
      VALUES ('token-1', 'member-1', 'human', 'cli', 'admin', 'secret', 'key', 'member-1',
        'self', '2026-08-01T00:00:00.000Z', NULL, NULL, NULL);
      INSERT INTO tickets
        (id, key, project, title, body, status, priority, assignee, created_at, updated_at, seq)
      VALUES ('ticket-1', 'DEMO-1', '00000000000000000000000000', 'Titleword title',
        'Bodyword body', 'todo', 'none', NULL, '2026-08-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z', 1);
      INSERT INTO comments
        (id, ticket_id, body, member_id, token_id, token_kind, agent_name,
         delegating_member_id, created_at, seq)
      VALUES ('comment-1', 'ticket-1', 'Commentword comment', 'member-1', 'token-1', 'human',
        NULL, NULL, '2026-08-01T00:00:00.000Z', 2);
    `)

    migrate(sql)

    for (const term of ['titleword', 'bodyword', 'commentword']) {
      expect(
        sql.database
          .prepare('SELECT count(*) AS count FROM ticket_search WHERE ticket_search MATCH ?')
          .get(term)
      ).toEqual({ count: 1 })
    }
    sql.database.exec('DELETE FROM ticket_search')
    rebuildTicketSearch(sql)
    expect(
      sql.database
        .prepare("SELECT source_kind FROM ticket_search WHERE ticket_search MATCH 'commentword'")
        .all()
    ).toEqual([{ source_kind: 'comment' }])

    const rowid = sql.database
      .prepare("SELECT rowid FROM ticket_search WHERE source_kind = 'ticket'")
      .get()
    sql.database.exec("UPDATE tickets SET status = 'done' WHERE id = 'ticket-1'")
    expect(
      sql.database.prepare("SELECT rowid FROM ticket_search WHERE source_kind = 'ticket'").get()
    ).toEqual(rowid)

    sql.database.exec(
      "UPDATE tickets SET title = 'Newtitle', body = 'Newbody' WHERE id = 'ticket-1'"
    )
    for (const term of ['titleword', 'bodyword']) {
      expect(
        sql.database
          .prepare('SELECT count(*) AS count FROM ticket_search WHERE ticket_search MATCH ?')
          .get(term)
      ).toEqual({ count: 0 })
    }
    expect(
      sql.database
        .prepare("SELECT count(*) AS count FROM ticket_search WHERE ticket_search MATCH 'newtitle'")
        .get()
    ).toEqual({ count: 1 })

    sql.database.exec("DELETE FROM tickets WHERE id = 'ticket-1'")
    expect(sql.database.prepare('SELECT count(*) AS count FROM ticket_search').get()).toEqual({
      count: 0,
    })
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

    const ticket = jsonObjectSchema.parse(sql.database.prepare('SELECT * FROM tickets').get())
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
    const createdAt = z.string().parse(ticket.created_at)
    expect(new Date(createdAt).toISOString()).toBe(createdAt)
    expect(ticket.updated_at).toBe(createdAt)
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
