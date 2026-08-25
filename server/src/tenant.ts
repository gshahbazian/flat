import { DurableObject } from 'cloudflare:workers'

import { conflictingFields } from './conflict'
import {
  canonicalSha256,
  configuredVerifier,
  createCredential,
  hmacHex,
  newUlid,
  parseCredential,
  parseKeyRing,
  randomHexSecret,
  verifyHmac,
  type HmacKey,
} from './crypto'
import { closingTicketKeys, verifyGithubSignature } from './github'
import type { Env } from './index'
import { runMigrations } from './migrations'
import { may, roleCeiling, validTokenAccess, type Action, type Principal } from './policy'
import {
  Entity,
  MemberStatus,
  MutationOp,
  Role,
  Status,
  TokenAccess,
  TokenKind,
  type AppliedMutation,
  type MemberProfile,
  type Mutation,
  type MutationConflict,
  type Snapshot,
  type SyncResponse,
  type Ticket,
  type TicketSet,
  type TicketTombstone,
} from './schema.gen'
import { invalidEmail, invalidTenantName, invalidTitle, invalidTokenName } from './validate'

export const PROTOCOL_VERSION = 1

const BOOTSTRAP_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled')),
  seq INTEGER NOT NULL CHECK (seq >= 0)
);
CREATE TABLE IF NOT EXISTS mutation_log (
  seq INTEGER PRIMARY KEY CHECK (seq >= 0),
  mutation_id TEXT NOT NULL UNIQUE,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mutation_log_entity ON mutation_log (entity_id, seq);
CREATE TABLE IF NOT EXISTS applied_mutations (
  mutation_id TEXT PRIMARY KEY,
  result TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('project_key', 'DEMO');
INSERT OR IGNORE INTO meta (key, value) VALUES ('next_ticket_num', '1');
INSERT OR IGNORE INTO meta (key, value) VALUES ('latest_seq', '0');
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '0');
`

const STATUSES = new Set<string>(Object.values(Status))
const ROLES = new Set(Object.values(Role))
const TOKEN_KINDS = new Set(Object.values(TokenKind))
const TOKEN_ACCESS = new Set(Object.values(TokenAccess))
const DEFAULT_ENROLLMENT_SECONDS = 24 * 60 * 60
const MAX_ENROLLMENT_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_AGENT_SECONDS = 30 * 24 * 60 * 60
const MAX_AGENT_SECONDS = 90 * 24 * 60 * 60
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000
const MAX_SEQUENCE = 0xffff_ffff
const MAX_GITHUB_BODY_BYTES = 1024 * 1024
const MAX_GITHUB_DELIVERY_LENGTH = 128
const MAX_GITHUB_REPOSITORY_LENGTH = 256
const MAX_GITHUB_URL_LENGTH = 2048
const MAX_GITHUB_TITLE_LENGTH = 1024

class PrincipalChangedError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: 'invalid_token' | 'forbidden'
  ) {
    super(code)
  }
}

class DuplicateTokenNameError extends Error {}

interface TokenRow {
  id: string
  member_id: string
  kind: TokenKind
  name: string
  access: TokenAccess
  secret_verifier: string
  verifier_key_id: string
  created_by: string | null
  expires_at: string | null
  revoked_at: string | null
  email: string
  role: Role
  member_status: MemberStatus
}

interface EnrollmentRow {
  id: string
  member_id: string
  kind: 'invite' | 'recovery' | 'upgrade'
  secret_verifier: string
  verifier_key_id: string
  intended_role: Role | null
  intended_access: TokenAccess | null
  created_by: string | null
  created_by_kind: 'human' | 'deployment'
  created_at: string
  expires_at: string
  consumed_at: string | null
  revoked_at: string | null
  member_status: MemberStatus
  member_role: Role | null
}

interface MemberRow {
  id: string
  email: string
  role: Role | null
  status: MemberStatus
  invited_by: string | null
  created_at: string
  activated_at: string | null
  suspended_at: string | null
}

interface PreparedCredential {
  id: string
  credential: string
  verifier: string
  keyId: string
}

function jsonError(status: number, code: string): Response {
  return Response.json({ error: code }, { status })
}

function emptyOk(): Response {
  return new Response(null, { status: 200 })
}

function isoNow(): string {
  return new Date().toISOString()
}

function addSeconds(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1000).toISOString()
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | null {
  if (typeof value !== 'string') return null
  for (const item of allowed) {
    if (item === value) return item
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

type SqlRow<T> = T & Record<string, SqlStorageValue>

function duration(value: unknown, fallback: number, maximum: number): number | null {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > maximum) {
    return null
  }
  return value
}

function parseApplied(value: unknown): AppliedMutation | null {
  if (!isRecord(value)) return null
  if (typeof value.mutation_id !== 'string') return null
  if (typeof value.entity_id !== 'string') return null
  if (typeof value.key !== 'string') return null
  if (typeof value.seq !== 'number') return null
  return {
    mutation_id: value.mutation_id,
    entity_id: value.entity_id,
    key: value.key,
    seq: value.seq,
  }
}

async function requestObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json<unknown>()
    if (!isRecord(value)) return null
    return value
  } catch {
    return null
  }
}

async function boundedBody(request: Request, maximumBytes: number): Promise<ArrayBuffer | null> {
  if (request.body === null) return new ArrayBuffer(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    // ReadableStream chunks have to be pulled in order.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maximumBytes) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body.buffer
}

export class TenantDO extends DurableObject<Env> {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec('PRAGMA foreign_keys = ON')
    this.sql.exec(BOOTSTRAP_SCHEMA)
    runMigrations(this.sql, (closure) => this.ctx.storage.transactionSync(closure))
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const { pathname } = url

    if (request.method === 'POST' && pathname === '/hooks/github') {
      return this.handleGithub(request)
    }
    if (request.method === 'POST' && pathname === '/setup') {
      return this.handleSetup(request)
    }
    if (request.method === 'POST' && pathname === '/operator/recover') {
      return this.handleOperatorRecovery(request)
    }
    if (request.method === 'POST' && pathname === '/enroll/invite') {
      return this.handleEnrollmentRedemption(request, 'invite')
    }
    if (request.method === 'POST' && pathname === '/enroll/recover') {
      return this.handleEnrollmentRedemption(request, 'recovery')
    }

    if (!this.initialized()) return jsonError(409, 'setup_required')
    const principal = await this.authenticate(request)
    if (principal instanceof Response) return principal

    try {
      return await this.handleAuthenticated(request, url, principal)
    } catch (error) {
      if (error instanceof PrincipalChangedError) {
        return jsonError(error.status, error.code)
      }
      throw error
    }
  }

  private async handleAuthenticated(
    request: Request,
    url: URL,
    principal: Principal
  ): Promise<Response> {
    const { pathname } = url
    if (request.method === 'POST' && pathname === '/sync') {
      return this.handleSync(request, principal)
    }
    if (request.method === 'GET' && pathname === '/snapshot') {
      return this.handleSnapshot(principal)
    }
    if (request.method === 'POST' && pathname === '/hooks/github/setup') {
      return this.handleGithubSetup(request, url, principal)
    }
    if (request.method === 'GET' && pathname === '/members') {
      return this.handleMembers(url, principal)
    }
    if (request.method === 'POST' && pathname === '/members/invite') {
      return this.handleInvitation(request, principal)
    }
    if (request.method === 'POST' && pathname === '/members/cancel') {
      return this.handleMemberCancel(request, principal)
    }
    if (request.method === 'POST' && pathname === '/members/recover') {
      return this.handleRecovery(request, principal)
    }
    if (request.method === 'POST' && pathname === '/members/upgrade') {
      return this.handleUpgradeCreation(request, principal)
    }
    if (request.method === 'POST' && pathname === '/members/suspend') {
      return this.handleMemberStatus(request, principal, MemberStatus.Suspended)
    }
    if (request.method === 'POST' && pathname === '/members/reactivate') {
      return this.handleMemberStatus(request, principal, MemberStatus.Active)
    }
    if (request.method === 'POST' && pathname === '/members/role') {
      return this.handleMemberRole(request, principal)
    }
    if (request.method === 'GET' && pathname === '/tokens') {
      return this.handleTokens(url, principal)
    }
    if (request.method === 'POST' && pathname === '/tokens') {
      return this.handleTokenCreate(request, principal)
    }
    if (request.method === 'POST' && pathname === '/tokens/revoke') {
      return this.handleTokenRevoke(request, principal)
    }
    if (request.method === 'POST' && pathname === '/tokens/upgrade') {
      return this.handleTokenUpgrade(request, principal)
    }
    if (request.method === 'GET' && pathname === '/audit') {
      return this.handleAudit(url, principal)
    }

    return jsonError(404, 'not_found')
  }

  private initialized(): boolean {
    return this.sql.exec('SELECT 1 FROM tenant_metadata WHERE singleton = 1').toArray().length > 0
  }

  private keys(): HmacKey[] {
    return parseKeyRing(this.env.FLAT_HMAC_KEYS)
  }

  private async prepareCredential(prefix: string): Promise<PreparedCredential> {
    const generated = createCredential(prefix)
    const key = this.keys()[0]
    return {
      id: generated.id,
      credential: generated.credential,
      verifier: await hmacHex(key, generated.secret),
      keyId: key.id,
    }
  }

  private async verifyConfiguredCredential(
    credential: unknown,
    prefix: 'flat_setup' | 'flat_oprec',
    configured: string | undefined
  ): Promise<boolean> {
    const value = typeof credential === 'string' ? credential : ''
    const wellFormed =
      value.startsWith(`${prefix}_`) && /^[A-Za-z0-9_-]{43,}$/.test(value.slice(prefix.length + 1))
    const parsed = configuredVerifier(configured)
    const keys = this.keys()
    const key = keys.find((candidate) => candidate.id === parsed?.keyId) ?? keys[0]
    const verifier = parsed?.verifier ?? '0'.repeat(64)
    const matches = await verifyHmac(key, value, verifier)
    return wellFormed && parsed !== null && matches
  }

  private async authenticate(request: Request): Promise<Principal | Response> {
    const authorization = request.headers.get('Authorization')
    const raw = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
    const parsed = parseCredential(raw, 'flat_pat')
    const rows = parsed
      ? this.sql
          .exec<SqlRow<TokenRow>>(
            `SELECT t.*, m.email, m.role, m.status AS member_status
         FROM tokens t JOIN members m ON m.id = t.member_id WHERE t.id = ?`,
            parsed.id
          )
          .toArray()
      : []
    const row = rows[0]
    const keys = this.keys()
    const key = keys.find((candidate) => candidate.id === row?.verifier_key_id) ?? keys[0]
    const verifier = row?.secret_verifier ?? '0'.repeat(64)
    const secret = parsed?.secret ?? 'invalid'
    const matches = await verifyHmac(key, secret, verifier)

    if (!parsed || !row || !matches || key.id !== row.verifier_key_id) {
      return jsonError(401, 'invalid_token')
    }
    if (row.revoked_at !== null) return jsonError(401, 'invalid_token')
    if (row.expires_at !== null && Date.parse(row.expires_at) <= Date.now()) {
      return jsonError(401, 'invalid_token')
    }
    if (row.member_status !== MemberStatus.Active) {
      return jsonError(401, 'invalid_token')
    }

    const now = new Date()
    const cutoff = new Date(now.getTime() - LAST_USED_WRITE_INTERVAL_MS).toISOString()
    this.sql.exec(
      `UPDATE tokens SET last_used_at = ? WHERE id = ?
       AND (last_used_at IS NULL OR last_used_at < ?)`,
      now.toISOString(),
      row.id,
      cutoff
    )
    return {
      memberId: row.member_id,
      email: row.email,
      role: row.role,
      tokenId: row.id,
      tokenKind: row.kind,
      tokenName: row.name,
      access: row.access,
      createdBy: row.created_by,
    }
  }

  private requireCurrentPrincipal(principal: Principal, action: Action): Principal {
    const row = this.sql
      .exec<SqlRow<TokenRow>>(
        `SELECT t.*, m.email, m.role, m.status AS member_status
       FROM tokens t JOIN members m ON m.id = t.member_id WHERE t.id = ?`,
        principal.tokenId
      )
      .toArray()[0]
    const expired =
      row !== undefined && row.expires_at !== null && Date.parse(row.expires_at) <= Date.now()
    const verifierAvailable =
      row !== undefined && this.keys().some((key) => key.id === row.verifier_key_id)
    if (
      !row ||
      row.member_id !== principal.memberId ||
      row.revoked_at !== null ||
      expired ||
      row.member_status !== MemberStatus.Active ||
      !verifierAvailable
    ) {
      throw new PrincipalChangedError(401, 'invalid_token')
    }

    const current: Principal = {
      memberId: row.member_id,
      email: row.email,
      role: row.role,
      tokenId: row.id,
      tokenKind: row.kind,
      tokenName: row.name,
      access: row.access,
      createdBy: row.created_by,
    }
    if (!may(current, action)) throw new PrincipalChangedError(403, 'forbidden')
    return current
  }

  private async handleSetup(request: Request): Promise<Response> {
    const body = await requestObject(request)
    if (!body) return jsonError(400, 'invalid_json')
    if (this.initialized()) return jsonError(409, 'setup_already_completed')
    const validSecret = await this.verifyConfiguredCredential(
      body.setup_credential ?? body.credential,
      'flat_setup',
      this.env.FLAT_SETUP_VERIFIER
    )
    if (!validSecret) return jsonError(401, 'invalid_setup')

    const email = invalidEmail(body.email ?? body.admin_email)
    if (email === null) return jsonError(422, 'invalid_email')
    const tenantName = invalidTenantName(body.tenant_name ?? body.display_name)
    if (tenantName === null) return jsonError(422, 'invalid_tenant_name')
    const rawTokenName = body.token_name ?? body.cli_name ?? body.name
    const tokenName = typeof rawTokenName === 'string' ? rawTokenName.trim() : ''
    if (invalidTokenName(tokenName)) return jsonError(422, 'invalid_token_name')

    const token = await this.prepareCredential('flat_pat')
    const memberId = newUlid()
    const now = isoNow()
    try {
      this.ctx.storage.transactionSync(() => {
        if (this.initialized()) throw new Error('setup_already_completed')
        this.sql.exec(
          'INSERT INTO tenant_metadata (singleton, display_name, initialized_at) VALUES (1, ?, ?)',
          tenantName,
          now
        )
        this.sql.exec(
          `INSERT INTO members
           (id, email, role, status, invited_by, created_at, activated_at, suspended_at)
           VALUES (?, ?, 'admin', 'active', NULL, ?, ?, NULL)`,
          memberId,
          email,
          now,
          now
        )
        this.insertToken(
          token,
          memberId,
          TokenKind.Human,
          tokenName,
          TokenAccess.Admin,
          memberId,
          'setup',
          null,
          now
        )
        const seq = this.nextSeq()
        this.audit(seq, 'tenant.setup', null, 'deployment', 'tenant', 'tenant', {
          member_id: memberId,
          token_id: token.id,
        })
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'setup_already_completed') {
        return jsonError(409, 'setup_already_completed')
      }
      throw error
    }

    return Response.json(
      {
        token: token.credential,
        member: this.memberProfile(memberId),
        tenant: { display_name: tenantName, initialized_at: now },
        snapshot: this.snapshot(),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  }

  private async handleSync(request: Request, principal: Principal): Promise<Response> {
    if (!may(principal, 'work.read')) return jsonError(403, 'forbidden')
    const body = await requestObject(request)
    if (!body) return jsonError(400, 'invalid_json')
    if (body.protocol_version !== PROTOCOL_VERSION) {
      return jsonError(400, 'unsupported_protocol_version')
    }
    if (
      !Array.isArray(body.mutations) ||
      typeof body.last_seq !== 'number' ||
      !Number.isSafeInteger(body.last_seq) ||
      body.last_seq < 0 ||
      body.last_seq > MAX_SEQUENCE
    ) {
      return jsonError(400, 'malformed_sync_request')
    }
    const lastSeq = body.last_seq
    const mutations = body.mutations

    const hashes = await Promise.all(mutations.map((mutation) => canonicalSha256(mutation)))

    const applied: AppliedMutation[] = []
    const conflicts: MutationConflict[] = []
    this.ctx.storage.transactionSync(() => {
      const currentPrincipal = this.requireCurrentPrincipal(principal, 'work.read')
      for (const [index, raw] of mutations.entries()) {
        if (!isRecord(raw)) {
          conflicts.push({ mutation_id: '', entity_id: '', reason: 'malformed mutation' })
          continue
        }
        const mutation = raw
        const reject = (reason: string): void => {
          conflicts.push({
            mutation_id: typeof mutation.mutation_id === 'string' ? mutation.mutation_id : '',
            entity_id: typeof mutation.entity_id === 'string' ? mutation.entity_id : '',
            reason,
          })
        }
        if (typeof mutation.mutation_id !== 'string' || mutation.mutation_id.length === 0) {
          reject('mutation_id is required')
          continue
        }
        const action = this.mutationAction(mutation)
        if (!action || !may(currentPrincipal, action)) {
          reject('forbidden')
          continue
        }

        const hash = hashes[index]
        const prior = this.sql
          .exec<{
            actor_member_id: string | null
            mutation_hash: string | null
            stored_result: string
          }>(
            `SELECT actor_member_id, mutation_hash, COALESCE(stored_result, result) AS stored_result
           FROM applied_mutations WHERE mutation_id = ?`,
            mutation.mutation_id
          )
          .toArray()[0]
        if (prior) {
          if (prior.actor_member_id !== currentPrincipal.memberId || prior.mutation_hash !== hash) {
            reject('mutation_id_reused')
            continue
          }
          const stored = parseApplied(JSON.parse(prior.stored_result))
          if (!stored) {
            reject('stored_result_corrupt')
            continue
          }
          applied.push(stored)
          continue
        }

        const outcome = this.apply(mutation)
        if ('reason' in outcome) {
          conflicts.push(outcome)
          continue
        }
        const stored = JSON.stringify(outcome)
        this.sql.exec(
          `INSERT INTO applied_mutations
           (mutation_id, result, actor_member_id, actor_token_id, mutation_hash, stored_result)
           VALUES (?, ?, ?, ?, ?, ?)`,
          mutation.mutation_id,
          stored,
          currentPrincipal.memberId,
          currentPrincipal.tokenId,
          hash,
          stored
        )
        this.audit(
          outcome.seq,
          action,
          currentPrincipal,
          currentPrincipal.tokenKind,
          'ticket',
          outcome.entity_id,
          {
            mutation_id: outcome.mutation_id,
          }
        )
        applied.push(outcome)
      }
    })

    const response: SyncResponse = {
      applied,
      conflicts,
      deltas: this.ticketsSince(lastSeq),
      tombstones: this.tombstonesSince(lastSeq),
      members: this.memberProfiles(),
      latest_seq: this.latestSeq(),
    }
    return Response.json(response)
  }

  private handleSnapshot(principal: Principal): Response {
    if (!may(principal, 'work.read')) return jsonError(403, 'forbidden')
    return Response.json(this.snapshot())
  }

  private snapshot(): Snapshot {
    return {
      tickets: this.ticketsSince(0),
      members: this.memberProfiles(),
      latest_seq: this.latestSeq(),
    }
  }

  private mutationAction(mutation: Record<string, unknown> | Mutation): Action | null {
    if (mutation.entity !== Entity.Ticket) return null
    if (mutation.op === MutationOp.Create) return 'ticket.create'
    if (mutation.op === MutationOp.Update) return 'ticket.update'
    if (mutation.op === MutationOp.Delete) return 'ticket.delete'
    return null
  }

  private apply(mutation: Record<string, unknown> | Mutation): AppliedMutation | MutationConflict {
    const reject = (reason: string): MutationConflict => ({
      mutation_id: typeof mutation.mutation_id === 'string' ? mutation.mutation_id : '',
      entity_id: typeof mutation.entity_id === 'string' ? mutation.entity_id : '',
      reason,
    })
    if (mutation.entity !== Entity.Ticket) {
      return reject(`unknown entity ${JSON.stringify(mutation.entity)}`)
    }
    if (typeof mutation.mutation_id !== 'string' || mutation.mutation_id.length === 0) {
      return reject('mutation_id is required')
    }
    if (typeof mutation.entity_id !== 'string' || mutation.entity_id.length === 0) {
      return reject('entity_id is required')
    }
    if (mutation.set !== undefined && !isRecord(mutation.set)) {
      return reject('set must be an object')
    }
    const set = isRecord(mutation.set) ? mutation.set : {}
    for (const field of ['title', 'body'] as const) {
      if (set[field] != null && typeof set[field] !== 'string') {
        return reject(`set.${field} must be a string`)
      }
    }
    if (set.status != null && (typeof set.status !== 'string' || !STATUSES.has(set.status))) {
      return reject(`unknown status ${JSON.stringify(set.status)}`)
    }
    const parsedSet: TicketSet = {}
    if (typeof set.title === 'string') parsedSet.title = set.title
    if (typeof set.body === 'string') parsedSet.body = set.body
    const status = enumValue(set.status, new Set(Object.values(Status)))
    if (status !== null) parsedSet.status = status
    const title = parsedSet.title != null ? parsedSet.title.trim() : null
    if (title !== null) {
      const reason = invalidTitle(title)
      if (reason) return reject(reason)
    }

    if (mutation.op === MutationOp.Create) {
      if (mutation.base_seq !== undefined) {
        return reject('create must not include base_seq')
      }
      if (
        this.sql
          .exec(
            `SELECT 1 FROM tickets WHERE id = ?
         UNION ALL SELECT 1 FROM ticket_tombstones WHERE id = ? LIMIT 1`,
            mutation.entity_id,
            mutation.entity_id
          )
          .toArray().length > 0
      ) {
        return reject(`ticket ${mutation.entity_id} already exists`)
      }
      if (title == null) return reject('create requires set.title')
      const num = Number(this.meta('next_ticket_num'))
      const key = `${this.meta('project_key')}-${num}`
      const seq = this.nextSeq()
      this.sql.exec(
        'INSERT INTO tickets (id, key, title, body, status, seq) VALUES (?, ?, ?, ?, ?, ?)',
        mutation.entity_id,
        key,
        title,
        parsedSet.body ?? '',
        parsedSet.status ?? Status.Todo,
        seq
      )
      this.setMeta('next_ticket_num', String(num + 1))
      this.log(mutation, seq)
      return {
        mutation_id: mutation.mutation_id,
        entity_id: mutation.entity_id,
        key,
        seq,
      }
    }

    const rows = this.sql
      .exec<{ key: string; seq: number }>(
        'SELECT key, seq FROM tickets WHERE id = ?',
        mutation.entity_id
      )
      .toArray()
    if (rows.length === 0) return reject(`unknown ticket ${mutation.entity_id}`)
    const { key, seq: currentSeq } = rows[0]
    if (
      typeof mutation.base_seq !== 'number' ||
      !Number.isSafeInteger(mutation.base_seq) ||
      mutation.base_seq < 0 ||
      mutation.base_seq > MAX_SEQUENCE
    ) {
      return reject(
        `${typeof mutation.op === 'string' ? mutation.op : 'mutation'} requires a valid base_seq`
      )
    }
    if (mutation.base_seq > currentSeq) {
      return reject(`base_seq ${mutation.base_seq} is ahead of the ticket (seq ${currentSeq})`)
    }
    if (mutation.op === MutationOp.Delete) {
      const seq = this.nextSeq()
      this.sql.exec(
        'INSERT INTO ticket_tombstones (id, key, seq) VALUES (?, ?, ?)',
        mutation.entity_id,
        key,
        seq
      )
      this.sql.exec('DELETE FROM tickets WHERE id = ?', mutation.entity_id)
      this.log(mutation, seq)
      return {
        mutation_id: mutation.mutation_id,
        entity_id: mutation.entity_id,
        key,
        seq,
      }
    }
    if (mutation.op !== MutationOp.Update) {
      return reject(`unknown op ${JSON.stringify(mutation.op)}`)
    }

    if (mutation.base_seq < currentSeq) {
      const serverSets = this.sql
        .exec<{ payload: string }>(
          'SELECT payload FROM mutation_log WHERE entity_id = ? AND seq > ?',
          mutation.entity_id,
          mutation.base_seq
        )
        .toArray()
        .map((row) => {
          const parsed: unknown = JSON.parse(row.payload)
          if (!isRecord(parsed) || !isRecord(parsed.set)) return {}
          const prior: TicketSet = {}
          if (typeof parsed.set.title === 'string') prior.title = parsed.set.title
          if (typeof parsed.set.body === 'string') prior.body = parsed.set.body
          const priorStatus = enumValue(parsed.set.status, new Set(Object.values(Status)))
          if (priorStatus !== null) prior.status = priorStatus
          return prior
        })
      const conflicting = conflictingFields(parsedSet, serverSets)
      if (conflicting.length > 0) {
        return reject(
          `conflicting edits to ${conflicting.join(', ')} (ticket is at seq ${currentSeq}): run \`flat sync --merge\``
        )
      }
    }
    const seq = this.nextSeq()
    this.sql.exec(
      `UPDATE tickets SET title = COALESCE(?, title), status = COALESCE(?, status),
       body = COALESCE(?, body), seq = ? WHERE id = ?`,
      title,
      parsedSet.status ?? null,
      parsedSet.body ?? null,
      seq,
      mutation.entity_id
    )
    this.log(mutation, seq)
    return {
      mutation_id: mutation.mutation_id,
      entity_id: mutation.entity_id,
      key,
      seq,
    }
  }

  private async handleGithubSetup(
    request: Request,
    url: URL,
    principal: Principal
  ): Promise<Response> {
    if (!may(principal, 'integration.github.manage')) {
      return jsonError(403, 'forbidden')
    }
    const body = await boundedBody(request, 16 * 1024)
    if (body === null) return jsonError(413, 'payload_too_large')
    const currentPrincipal = this.requireCurrentPrincipal(principal, 'integration.github.manage')
    const rotate = url.searchParams.get('rotate') === '1'
    let secret = this.optionalMeta('github_webhook_secret')
    if (rotate) {
      const replacement = randomHexSecret()
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `INSERT INTO meta (key, value) VALUES ('github_webhook_secret', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          replacement
        )
        const seq = this.nextSeq()
        this.audit(
          seq,
          'github.secret.rotate',
          currentPrincipal,
          currentPrincipal.tokenKind,
          'integration',
          'github',
          {}
        )
      })
      secret = replacement
    }
    if (secret === null) {
      const candidate = randomHexSecret()
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "INSERT INTO meta (key, value) VALUES ('github_webhook_secret', ?)",
          candidate
        )
        const seq = this.nextSeq()
        this.audit(
          seq,
          'github.secret.create',
          currentPrincipal,
          currentPrincipal.tokenKind,
          'integration',
          'github',
          {}
        )
      })
      secret = candidate
    }
    return Response.json({ secret }, { headers: { 'Cache-Control': 'no-store' } })
  }

  private async handleGithub(request: Request): Promise<Response> {
    const contentType = request.headers.get('Content-Type') ?? ''
    if (!/^application\/json(?:\s*;.*)?$/i.test(contentType)) {
      return jsonError(415, 'unsupported_media_type')
    }
    const event = request.headers.get('X-GitHub-Event')
    const delivery = request.headers.get('X-GitHub-Delivery')
    if (!event || !delivery) return jsonError(400, 'missing_github_headers')
    if (event.length > 64 || delivery.length > MAX_GITHUB_DELIVERY_LENGTH) {
      return jsonError(400, 'invalid_github_headers')
    }
    const contentLength = request.headers.get('Content-Length')
    if (contentLength !== null) {
      const length = Number(contentLength)
      if (!Number.isSafeInteger(length) || length < 0) {
        return jsonError(400, 'invalid_content_length')
      }
      if (length > MAX_GITHUB_BODY_BYTES) {
        return jsonError(413, 'github_payload_too_large')
      }
    }
    const rawBody = await boundedBody(request, MAX_GITHUB_BODY_BYTES)
    if (rawBody === null) return jsonError(413, 'github_payload_too_large')
    const secret = this.optionalMeta('github_webhook_secret') ?? ''
    const valid =
      secret.length > 0 &&
      (await verifyGithubSignature(secret, rawBody, request.headers.get('X-Hub-Signature-256')))
    if (!valid) return jsonError(401, 'invalid_github_signature')

    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(rawBody))
    } catch {
      return jsonError(400, 'invalid_json')
    }
    if (!isRecord(parsed)) return jsonError(400, 'invalid_github_payload')
    if (event === 'ping' || event !== 'pull_request') return emptyOk()
    if (parsed.action !== 'closed') return emptyOk()

    if (!isRecord(parsed.pull_request) || !isRecord(parsed.repository)) {
      return jsonError(400, 'invalid_github_payload')
    }
    const pull = parsed.pull_request
    const repository = parsed.repository
    if (
      typeof pull.merged !== 'boolean' ||
      !isRecord(pull.base) ||
      typeof pull.base.ref !== 'string' ||
      typeof repository.default_branch !== 'string'
    ) {
      return jsonError(400, 'invalid_github_payload')
    }
    if (!pull.merged || pull.base.ref !== repository.default_branch) {
      return emptyOk()
    }
    const pullNumber = pull.number ?? parsed.number
    const validBody = pull.body === undefined || pull.body === null || typeof pull.body === 'string'
    if (
      typeof pullNumber !== 'number' ||
      !Number.isSafeInteger(pullNumber) ||
      pullNumber <= 0 ||
      typeof pull.title !== 'string' ||
      typeof pull.html_url !== 'string' ||
      typeof repository.full_name !== 'string' ||
      !validBody
    ) {
      return jsonError(400, 'invalid_github_payload')
    }
    if (
      pull.title.length > MAX_GITHUB_TITLE_LENGTH ||
      repository.full_name.length > MAX_GITHUB_REPOSITORY_LENGTH ||
      pull.html_url.length > MAX_GITHUB_URL_LENGTH ||
      pull.base.ref.length > 255 ||
      repository.default_branch.length > 255
    ) {
      return jsonError(400, 'invalid_github_payload')
    }

    const pullBody = typeof pull.body === 'string' ? pull.body : null
    const keys = closingTicketKeys(pull.title, pullBody)
    this.ctx.storage.transactionSync(() => {
      if (
        this.sql.exec('SELECT 1 FROM github_deliveries WHERE delivery_id = ?', delivery).toArray()
          .length > 0
      ) {
        return
      }
      const results: Array<Record<string, unknown>> = []
      for (const key of keys) {
        const row = this.sql
          .exec<{ id: string; status: Status; seq: number }>(
            'SELECT id, status, seq FROM tickets WHERE key = ?',
            key
          )
          .toArray()[0]
        if (!row) {
          results.push({ key, result: 'unknown' })
          continue
        }
        const ticketId = row.id
        const status = row.status
        const currentSeq = row.seq
        if (status === Status.Done) {
          results.push({
            key,
            ticket_id: ticketId,
            result: 'already_done',
            seq: currentSeq,
          })
          continue
        }
        if (status === Status.Canceled) {
          results.push({
            key,
            ticket_id: ticketId,
            result: 'canceled',
            seq: currentSeq,
          })
          continue
        }
        const mutation: Mutation = {
          mutation_id: `github:${delivery}:${ticketId}`,
          op: MutationOp.Update,
          entity: Entity.Ticket,
          entity_id: ticketId,
          base_seq: currentSeq,
          set: { status: Status.Done },
        }
        const outcome = this.apply(mutation)
        if ('reason' in outcome) {
          throw new Error(`GitHub mutation rejected: ${outcome.reason}`)
        }
        this.audit(outcome.seq, 'ticket.update', null, 'webhook', 'ticket', ticketId, {
          mutation_id: mutation.mutation_id,
          source: 'github',
          delivery_id: delivery,
        })
        results.push({
          key,
          ticket_id: ticketId,
          result: 'closed',
          seq: outcome.seq,
        })
      }
      this.sql.exec(
        `INSERT INTO github_deliveries
         (delivery_id, repository, pull_number, pull_url, processed_at, results_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        delivery,
        repository.full_name,
        pullNumber,
        pull.html_url,
        isoNow(),
        JSON.stringify({ version: 1, tickets: results })
      )
    })
    return emptyOk()
  }

  private async handleInvitation(request: Request, principal: Principal): Promise<Response> {
    if (!may(principal, 'member.invite')) return jsonError(403, 'forbidden')
    const body = await requestObject(request)
    if (!body) return jsonError(400, 'invalid_json')
    if (Array.isArray(body.members)) {
      return this.handleBulkInvitation(body.members, body, principal)
    }
    return this.createInvitation(body, principal)
  }

  private async handleBulkInvitation(
    rawMembers: unknown[],
    body: Record<string, unknown>,
    principal: Principal
  ): Promise<Response> {
    const seconds = duration(
      body.expires_in_seconds,
      DEFAULT_ENROLLMENT_SECONDS,
      MAX_ENROLLMENT_SECONDS
    )
    if (seconds === null || rawMembers.length === 0) {
      return jsonError(422, 'invalid_invitation')
    }
    const members: Array<{ email: string; role: Role }> = []
    const seen = new Set<string>()
    for (const raw of rawMembers) {
      if (!isRecord(raw)) {
        return jsonError(422, 'invalid_invitation')
      }
      const item = raw
      const email = invalidEmail(item.email)
      const role = enumValue<Role>(item.role ?? Role.Member, ROLES)
      if (email === null || role === null || seen.has(email)) {
        return jsonError(422, 'invalid_invitation')
      }
      seen.add(email)
      members.push({ email, role })
    }
    for (const member of members) {
      const existing = this.memberByEmail(member.email)
      if (existing?.status === MemberStatus.Active) {
        return jsonError(409, 'member_already_active')
      }
      if (existing?.status === MemberStatus.Suspended) {
        return jsonError(409, 'member_suspended')
      }
    }
    const prepared = await Promise.all(
      members.map(async (member) => ({
        email: member.email,
        role: member.role,
        enrollment: await this.prepareCredential('flat_inv'),
      }))
    )
    const now = isoNow()
    const expiresAt = addSeconds(now, seconds)
    this.ctx.storage.transactionSync(() => {
      const currentPrincipal = this.requireCurrentPrincipal(principal, 'member.invite')
      for (const item of prepared) {
        this.insertInvitation(
          item.email,
          item.role,
          item.enrollment,
          currentPrincipal,
          now,
          expiresAt
        )
      }
    })
    return Response.json(
      {
        invitations: prepared.map((item) => ({
          email: item.email,
          role: item.role,
          expires_at: expiresAt,
          invitation_code: item.enrollment.credential,
        })),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  }

  private async createInvitation(
    body: Record<string, unknown>,
    principal: Principal
  ): Promise<Response> {
    const email = invalidEmail(body.email)
    const role = enumValue<Role>(body.role ?? Role.Member, ROLES)
    const seconds = duration(
      body.expires_in_seconds,
      DEFAULT_ENROLLMENT_SECONDS,
      MAX_ENROLLMENT_SECONDS
    )
    if (email === null) return jsonError(422, 'invalid_email')
    if (role === null) return jsonError(422, 'invalid_role')
    if (seconds === null) return jsonError(422, 'invalid_expiry')
    const existing = this.memberByEmail(email)
    if (existing?.status === MemberStatus.Active) {
      return jsonError(409, 'member_already_active')
    }
    if (existing?.status === MemberStatus.Suspended) {
      return jsonError(409, 'member_suspended')
    }
    const enrollment = await this.prepareCredential('flat_inv')
    const now = isoNow()
    const expiresAt = addSeconds(now, seconds)
    this.ctx.storage.transactionSync(() => {
      const currentPrincipal = this.requireCurrentPrincipal(principal, 'member.invite')
      this.insertInvitation(email, role, enrollment, currentPrincipal, now, expiresAt)
    })
    return Response.json(
      {
        email,
        role,
        expires_at: expiresAt,
        invitation_code: enrollment.credential,
      },
      {
        headers: { 'Cache-Control': 'no-store' },
      }
    )
  }

  private insertInvitation(
    email: string,
    role: Role,
    enrollment: PreparedCredential,
    principal: Principal,
    now: string,
    expiresAt: string
  ): void {
    const member = this.memberByEmail(email)
    let memberId = member?.id
    if (!memberId) {
      memberId = newUlid()
      this.sql.exec(
        `INSERT INTO members
         (id, email, role, status, invited_by, created_at, activated_at, suspended_at)
         VALUES (?, ?, NULL, 'pending', ?, ?, NULL, NULL)`,
        memberId,
        email,
        principal.memberId,
        now
      )
    }
    this.expireEnrollments(now, memberId, 'invite')
    this.sql.exec(
      "UPDATE enrollments SET revoked_at = ? WHERE member_id = ? AND kind = 'invite' AND consumed_at IS NULL AND revoked_at IS NULL",
      now,
      memberId
    )
    this.sql.exec(
      `INSERT INTO enrollments
       (id, member_id, kind, secret_verifier, verifier_key_id, intended_role, intended_access,
        created_by, created_by_kind, created_at, expires_at, consumed_at, revoked_at)
       VALUES (?, ?, 'invite', ?, ?, ?, NULL, ?, 'human', ?, ?, NULL, NULL)`,
      enrollment.id,
      memberId,
      enrollment.verifier,
      enrollment.keyId,
      role,
      principal.memberId,
      now,
      expiresAt
    )
    const seq = this.nextSeq()
    this.audit(seq, 'member.invite', principal, principal.tokenKind, 'member', memberId, {
      email,
      role,
    })
  }

  private async handleEnrollmentRedemption(
    request: Request,
    kind: 'invite' | 'recovery'
  ): Promise<Response> {
    if (!this.initialized()) return jsonError(409, 'setup_required')
    const body = await requestObject(request)
    if (!body) return jsonError(400, 'invalid_json')
    const rawTokenName = body.token_name ?? body.cli_name ?? body.name
    const tokenName = typeof rawTokenName === 'string' ? rawTokenName.trim() : ''
    if (invalidTokenName(tokenName)) return jsonError(422, 'invalid_token_name')
    let enrollmentCredential = body.credential ?? body.recovery_code
    if (kind === 'invite') {
      enrollmentCredential = body.credential ?? body.invitation_code
    }
    const enrollment = await this.verifyEnrollment(enrollmentCredential, kind)
    if (enrollment instanceof Response) return enrollment
    if (
      enrollment.member_status !== (kind === 'invite' ? MemberStatus.Pending : MemberStatus.Active)
    ) {
      return jsonError(409, 'invalid_member_state')
    }
    const role = kind === 'invite' ? enrollment.intended_role : enrollment.member_role
    if (role === null) return jsonError(409, 'invalid_enrollment_state')
    const token = await this.prepareCredential('flat_pat')
    const now = isoNow()
    try {
      this.ctx.storage.transactionSync(() => {
        const current = this.enrollmentById(enrollment.id)
        if (!current || current.consumed_at || current.revoked_at) {
          throw new Error('enrollment_consumed')
        }
        const expectedStatus = kind === 'invite' ? MemberStatus.Pending : MemberStatus.Active
        if (current.member_status !== expectedStatus) {
          throw new Error('invalid_member_state')
        }
        if (kind === 'invite') {
          this.sql.exec(
            "UPDATE members SET role = ?, status = 'active', activated_at = ? WHERE id = ? AND status = 'pending'",
            role,
            now,
            enrollment.member_id
          )
        }
        this.sql.exec('UPDATE enrollments SET consumed_at = ? WHERE id = ?', now, enrollment.id)
        this.insertToken(
          token,
          enrollment.member_id,
          TokenKind.Human,
          tokenName,
          roleCeiling(role),
          enrollment.member_id,
          kind,
          null,
          now
        )
        const seq = this.nextSeq()
        this.audit(seq, `${kind}.redeem`, null, 'enrollment', 'member', enrollment.member_id, {
          enrollment_id: enrollment.id,
          token_id: token.id,
        })
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'enrollment_consumed') {
        return jsonError(409, 'enrollment_consumed')
      }
      if (error instanceof Error && error.message === 'invalid_member_state') {
        return jsonError(409, 'invalid_member_state')
      }
      if (error instanceof DuplicateTokenNameError) {
        return jsonError(409, 'duplicate_token_name')
      }
      throw error
    }
    return Response.json(
      {
        token: token.credential,
        member: this.memberProfile(enrollment.member_id),
        snapshot: this.snapshot(),
      },
      {
        headers: { 'Cache-Control': 'no-store' },
      }
    )
  }

  private async verifyEnrollment(
    value: unknown,
    kind: EnrollmentRow['kind']
  ): Promise<EnrollmentRow | Response> {
    let prefix = 'flat_upg'
    if (kind === 'invite') prefix = 'flat_inv'
    if (kind === 'recovery') prefix = 'flat_rec'
    const parsed = parseCredential(value, prefix)
    if (!parsed) return jsonError(422, 'invalid_credential_format')
    const row = this.enrollmentById(parsed.id)
    const keys = this.keys()
    const key = keys.find((candidate) => candidate.id === row?.verifier_key_id) ?? keys[0]
    const verifier = row?.secret_verifier ?? '0'.repeat(64)
    const valid = await verifyHmac(key, parsed.secret, verifier)
    if (!row || !valid || key.id !== row.verifier_key_id) {
      return jsonError(401, 'invalid_enrollment')
    }
    if (row.consumed_at) return jsonError(410, 'enrollment_consumed')
    if (Date.parse(row.expires_at) <= Date.now()) {
      return jsonError(410, 'enrollment_expired')
    }
    if (row.revoked_at) return jsonError(410, 'enrollment_revoked')
    if (row.kind !== kind) return jsonError(409, 'invalid_enrollment_kind')
    return row
  }

  private enrollmentById(id: string): EnrollmentRow | null {
    const row = this.sql
      .exec<SqlRow<EnrollmentRow>>(
        `SELECT e.*, m.status AS member_status, m.role AS member_role
       FROM enrollments e JOIN members m ON m.id = e.member_id WHERE e.id = ?`,
        id
      )
      .toArray()[0]
    return row ?? null
  }

  private async handleRecovery(request: Request, principal: Principal): Promise<Response> {
    if (!may(principal, 'member.recover')) return jsonError(403, 'forbidden')
    const body = await requestObject(request)
    if (!body) return jsonError(400, 'invalid_json')
    const email = invalidEmail(body.email)
    if (email === null) return jsonError(422, 'invalid_email')
    return this.createRecovery(email, principal, TokenKind.Human)
  }

  private async handleOperatorRecovery(request: Request): Promise<Response> {
    if (!this.initialized()) return jsonError(409, 'setup_required')
    const body = await requestObject(request)
    if (!body) return jsonError(400, 'invalid_json')
    const valid = await this.verifyConfiguredCredential(
      body.operator_credential ?? body.credential,
      'flat_oprec',
      this.env.FLAT_OPERATOR_RECOVERY_VERIFIER
    )
    const verifier = this.env.FLAT_OPERATOR_RECOVERY_VERIFIER ?? ''
    const consumed = this.optionalMeta('consumed_operator_recovery_verifier') === verifier
    if (!valid || consumed) return jsonError(401, 'invalid_operator_recovery')
    const email = invalidEmail(body.email)
    if (email === null) return jsonError(422, 'invalid_email')
    const member = this.memberByEmail(email)
    if (!member || member.status !== MemberStatus.Active || member.role !== Role.Admin) {
      return jsonError(409, 'operator_recovery_target_invalid')
    }
    return this.createRecovery(email, null, 'deployment', verifier, 15 * 60)
  }

  private async createRecovery(
    email: string,
    principal: Principal | null,
    actorKind: TokenKind.Human | 'deployment',
    consumedVerifier?: string,
    lifetime = DEFAULT_ENROLLMENT_SECONDS
  ): Promise<Response> {
    const member = this.memberByEmail(email)
    if (!member || member.status !== MemberStatus.Active) {
      return jsonError(409, 'member_not_active')
    }
    const enrollment = await this.prepareCredential('flat_rec')
    const now = isoNow()
    const expiresAt = addSeconds(now, lifetime)
    let revokedTokenIds: string[] = []
    this.ctx.storage.transactionSync(() => {
      let currentPrincipal = principal
      if (principal) {
        currentPrincipal = this.requireCurrentPrincipal(principal, 'member.recover')
      }
      revokedTokenIds = this.sql
        .exec<{ id: string }>(
          'SELECT id FROM tokens WHERE member_id = ? AND revoked_at IS NULL',
          member.id
        )
        .toArray()
        .map((row) => row.id)
      this.sql.exec(
        'UPDATE tokens SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL',
        now,
        member.id
      )
      this.sql.exec(
        `UPDATE enrollments SET revoked_at = ?
         WHERE member_id = ? AND kind IN ('recovery', 'upgrade') AND consumed_at IS NULL AND revoked_at IS NULL`,
        now,
        member.id
      )
      this.sql.exec(
        `INSERT INTO enrollments
         (id, member_id, kind, secret_verifier, verifier_key_id, intended_role, intended_access,
          created_by, created_by_kind, created_at, expires_at, consumed_at, revoked_at)
         VALUES (?, ?, 'recovery', ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL)`,
        enrollment.id,
        member.id,
        enrollment.verifier,
        enrollment.keyId,
        currentPrincipal?.memberId ?? null,
        actorKind,
        now,
        expiresAt
      )
      if (consumedVerifier !== undefined) {
        this.sql.exec(
          `INSERT INTO meta (key, value) VALUES ('consumed_operator_recovery_verifier', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          consumedVerifier
        )
      }
      const seq = this.nextSeq()
      this.audit(seq, 'member.recover', currentPrincipal, actorKind, 'member', member.id, {
        enrollment_id: enrollment.id,
        revoked_token_ids: revokedTokenIds,
      })
    })
    this.closeTokenSessions(revokedTokenIds)
    return Response.json(
      { email, expires_at: expiresAt, recovery_code: enrollment.credential },
      {
        headers: { 'Cache-Control': 'no-store' },
      }
    )
  }

  private async handleUpgradeCreation(request: Request, principal: Principal): Promise<Response> {
    if (!may(principal, 'member.upgrade')) return jsonError(403, 'forbidden')
    const body = await requestObject(request)
    if (!body) return jsonError(400, 'invalid_json')
    const email = invalidEmail(body.email)
    if (email === null) return jsonError(422, 'invalid_email')
    const member = this.memberByEmail(email)
    if (!member || member.status !== MemberStatus.Active || member.role === null) {
      return jsonError(409, 'member_not_active')
    }
    const intended = roleCeiling(member.role)
    const below = this.humanTokensBelow(member.id, intended)
    if (below === 0) return jsonError(409, 'token_already_upgraded')
    const live = this.liveUpgrade(member.id)
    if (live && body.replace !== true) {
      return jsonError(409, 'upgrade_already_pending')
    }
    const enrollment = await this.prepareCredential('flat_upg')
    const now = isoNow()
    const expiresAt = addSeconds(now, DEFAULT_ENROLLMENT_SECONDS)
    this.ctx.storage.transactionSync(() => {
      const currentPrincipal = this.requireCurrentPrincipal(principal, 'member.upgrade')
      this.expireEnrollments(now, member.id, 'upgrade')
      if (live) {
        this.sql.exec('UPDATE enrollments SET revoked_at = ? WHERE id = ?', now, live.id)
      }
      this.sql.exec(
        `INSERT INTO enrollments
         (id, member_id, kind, secret_verifier, verifier_key_id, intended_role, intended_access,
          created_by, created_by_kind, created_at, expires_at, consumed_at, revoked_at)
         VALUES (?, ?, 'upgrade', ?, ?, NULL, ?, ?, 'human', ?, ?, NULL, NULL)`,
        enrollment.id,
        member.id,
        enrollment.verifier,
        enrollment.keyId,
        intended,
        currentPrincipal.memberId,
        now,
        expiresAt
      )
      const seq = this.nextSeq()
      this.audit(
        seq,
        'member.upgrade',
        currentPrincipal,
        currentPrincipal.tokenKind,
        'member',
        member.id,
        {
          enrollment_id: enrollment.id,
          intended_access: intended,
        }
      )
    })
    return Response.json(
      {
        email,
        intended_access: intended,
        expires_at: expiresAt,
        upgrade_code: enrollment.credential,
        human_tokens_below: below,
      },
      {
        headers: { 'Cache-Control': 'no-store' },
      }
    )
  }

  private async handleTokenUpgrade(request: Request, principal: Principal): Promise<Response> {
    if (!may(principal, 'token.self.upgrade')) {
      return jsonError(403, 'forbidden')
    }
    const body = await requestObject(request)
    if (!body) return jsonError(400, 'invalid_json')
    const enrollment = await this.verifyEnrollment(body.credential ?? body.upgrade_code, 'upgrade')
    if (enrollment instanceof Response) return enrollment
    if (enrollment.member_id !== principal.memberId) {
      return jsonError(401, 'invalid_enrollment')
    }
    const intendedAccess = enrollment.intended_access
    if (intendedAccess === null) {
      return jsonError(409, 'invalid_enrollment_state')
    }
    if (this.accessRank(principal.access) >= this.accessRank(intendedAccess)) {
      return jsonError(409, 'token_already_upgraded')
    }
    if (!validTokenAccess(principal.role, TokenKind.Human, intendedAccess)) {
      return jsonError(409, 'upgrade_not_allowed')
    }
    const now = isoNow()
    try {
      this.ctx.storage.transactionSync(() => {
        const currentPrincipal = this.requireCurrentPrincipal(principal, 'token.self.upgrade')
        const current = this.enrollmentById(enrollment.id)
        if (!current || current.consumed_at || current.revoked_at) {
          throw new Error('enrollment_consumed')
        }
        if (
          current.member_role === null ||
          !validTokenAccess(current.member_role, TokenKind.Human, intendedAccess)
        ) {
          throw new Error('upgrade_not_allowed')
        }
        this.sql.exec(
          'UPDATE tokens SET access = ? WHERE id = ?',
          intendedAccess,
          currentPrincipal.tokenId
        )
        this.sql.exec('UPDATE enrollments SET consumed_at = ? WHERE id = ?', now, enrollment.id)
        const seq = this.nextSeq()
        this.audit(
          seq,
          'token.upgrade',
          currentPrincipal,
          currentPrincipal.tokenKind,
          'token',
          currentPrincipal.tokenId,
          {
            enrollment_id: enrollment.id,
            from: currentPrincipal.access,
            to: intendedAccess,
          }
        )
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'enrollment_consumed') {
        return jsonError(409, 'enrollment_consumed')
      }
      if (error instanceof Error && error.message === 'upgrade_not_allowed') {
        return jsonError(409, 'upgrade_not_allowed')
      }
      throw error
    }
    return Response.json({
      access: intendedAccess,
      human_tokens_below: this.humanTokensBelow(principal.memberId, intendedAccess),
    })
  }

  private async handleMemberCancel(request: Request, principal: Principal): Promise<Response> {
    if (!may(principal, 'member.cancel')) return jsonError(403, 'forbidden')
    const body = await requestObject(request)
    if (!body) return jsonError(400, 'invalid_json')
    const email = invalidEmail(body.email)
    if (email === null) return jsonError(422, 'invalid_email')
    const member = this.memberByEmail(email)
    if (!member || member.status !== MemberStatus.Pending) {
      return jsonError(409, 'member_not_pending')
    }
    const invitation = this.sql
      .exec(
        "SELECT intended_role, created_by FROM enrollments WHERE member_id = ? AND kind = 'invite' ORDER BY created_at DESC LIMIT 1",
        member.id
      )
      .toArray()[0]
    this.ctx.storage.transactionSync(() => {
      const currentPrincipal = this.requireCurrentPrincipal(principal, 'member.cancel')
      this.sql.exec('DELETE FROM enrollments WHERE member_id = ?', member.id)
      this.sql.exec('DELETE FROM members WHERE id = ?', member.id)
      const seq = this.nextSeq()
      this.audit(
        seq,
        'member.cancel',
        currentPrincipal,
        currentPrincipal.tokenKind,
        'member',
        member.id,
        {
          email,
          intended_role: invitation?.intended_role ?? null,
          invited_by: invitation?.created_by ?? null,
        }
      )
    })
    return emptyOk()
  }

  private async handleMemberStatus(
    request: Request,
    principal: Principal,
    status: MemberStatus.Suspended | MemberStatus.Active
  ): Promise<Response> {
    const action = status === MemberStatus.Suspended ? 'member.suspend' : 'member.reactivate'
    if (!may(principal, action)) return jsonError(403, 'forbidden')
    const body = await requestObject(request)
    if (!body) return jsonError(400, 'invalid_json')
    const email = invalidEmail(body.email)
    if (email === null) return jsonError(422, 'invalid_email')
    const member = this.memberByEmail(email)
    if (!member || member.role === null) {
      return jsonError(409, 'member_not_found')
    }
    if (
      status === MemberStatus.Suspended &&
      member.status === MemberStatus.Active &&
      member.role === Role.Admin &&
      this.activeAdminCount() === 1
    ) {
      return jsonError(409, 'last_active_admin')
    }
    const now = isoNow()
    let revokedTokenIds: string[] = []
    try {
      this.ctx.storage.transactionSync(() => {
        const currentPrincipal = this.requireCurrentPrincipal(principal, action)
        if (
          status === MemberStatus.Suspended &&
          member.role === Role.Admin &&
          member.status === MemberStatus.Active &&
          this.activeAdminCount() === 1
        ) {
          throw new Error('last_active_admin')
        }
        if (status === MemberStatus.Suspended) {
          revokedTokenIds = this.sql
            .exec<{ id: string }>(
              'SELECT id FROM tokens WHERE member_id = ? AND revoked_at IS NULL',
              member.id
            )
            .toArray()
            .map((row) => row.id)
          this.sql.exec(
            "UPDATE members SET status = 'suspended', suspended_at = ? WHERE id = ?",
            now,
            member.id
          )
          this.sql.exec(
            'UPDATE tokens SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL',
            now,
            member.id
          )
          this.sql.exec(
            `UPDATE enrollments SET revoked_at = ?
             WHERE member_id = ? AND kind IN ('recovery', 'upgrade') AND consumed_at IS NULL AND revoked_at IS NULL`,
            now,
            member.id
          )
          this.sql.exec('DELETE FROM project_owners WHERE member_id = ?', member.id)
        } else {
          this.sql.exec(
            "UPDATE members SET status = 'active', suspended_at = NULL WHERE id = ?",
            member.id
          )
        }
        const seq = this.nextSeq()
        this.audit(seq, action, currentPrincipal, currentPrincipal.tokenKind, 'member', member.id, {
          revoked_token_ids: revokedTokenIds,
        })
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'last_active_admin') {
        return jsonError(409, 'last_active_admin')
      }
      throw error
    }
    this.closeTokenSessions(revokedTokenIds)
    return Response.json({ member: this.memberProfile(member.id) })
  }

  private async handleMemberRole(request: Request, principal: Principal): Promise<Response> {
    if (!may(principal, 'member.change_role')) {
      return jsonError(403, 'forbidden')
    }
    const body = await requestObject(request)
    if (!body) return jsonError(400, 'invalid_json')
    const email = invalidEmail(body.email)
    const nextRole = enumValue<Role>(body.role, ROLES)
    if (email === null) return jsonError(422, 'invalid_email')
    if (nextRole === null) return jsonError(422, 'invalid_role')
    const member = this.memberByEmail(email)
    if (!member || member.status === MemberStatus.Pending || member.role === null) {
      return jsonError(409, 'member_not_active')
    }
    const previousRole = member.role
    if (
      previousRole === Role.Admin &&
      nextRole !== Role.Admin &&
      member.status === MemberStatus.Active &&
      this.activeAdminCount() === 1
    ) {
      return jsonError(409, 'last_active_admin')
    }
    const previousCeiling = roleCeiling(previousRole)
    const nextCeiling = roleCeiling(nextRole)
    const demotion = this.accessRank(nextCeiling) < this.accessRank(previousCeiling)
    const promotion = this.accessRank(nextCeiling) > this.accessRank(previousCeiling)
    const possibleUpgrade =
      promotion &&
      member.status === MemberStatus.Active &&
      !this.liveUpgrade(member.id) &&
      this.humanTokensBelow(member.id, nextCeiling) > 0
    const enrollment = possibleUpgrade ? await this.prepareCredential('flat_upg') : null
    const now = isoNow()
    const revokedTokenIds: string[] = []
    try {
      this.ctx.storage.transactionSync(() => {
        const currentPrincipal = this.requireCurrentPrincipal(principal, 'member.change_role')
        const currentMember = this.memberById(member.id)
        if (
          !currentMember ||
          currentMember.role !== previousRole ||
          currentMember.status !== member.status
        ) {
          throw new Error('member_changed')
        }
        if (
          previousRole === Role.Admin &&
          nextRole !== Role.Admin &&
          member.status === MemberStatus.Active &&
          this.activeAdminCount() === 1
        ) {
          throw new Error('last_active_admin')
        }
        this.sql.exec('UPDATE members SET role = ? WHERE id = ?', nextRole, member.id)
        if (demotion) {
          for (const row of this.sql
            .exec<{ id: string; access: TokenAccess }>(
              'SELECT id, access FROM tokens WHERE member_id = ? AND revoked_at IS NULL',
              member.id
            )
            .toArray()) {
            if (this.accessRank(row.access) > this.accessRank(nextCeiling)) {
              revokedTokenIds.push(row.id)
            }
          }
          for (const id of revokedTokenIds) {
            this.sql.exec('UPDATE tokens SET revoked_at = ? WHERE id = ?', now, id)
          }
          this.sql.exec(
            `UPDATE enrollments SET revoked_at = ? WHERE member_id = ? AND kind = 'upgrade'
             AND consumed_at IS NULL AND revoked_at IS NULL
             AND ((? = 'read' AND intended_access IN ('write', 'admin'))
               OR (? = 'write' AND intended_access = 'admin'))`,
            now,
            member.id,
            nextCeiling,
            nextCeiling
          )
          if (nextRole === Role.Viewer) {
            this.sql.exec('DELETE FROM project_owners WHERE member_id = ?', member.id)
          }
        }
        if (enrollment) {
          this.expireEnrollments(now, member.id, 'upgrade')
          this.sql.exec(
            `INSERT INTO enrollments
             (id, member_id, kind, secret_verifier, verifier_key_id, intended_role, intended_access,
              created_by, created_by_kind, created_at, expires_at, consumed_at, revoked_at)
             VALUES (?, ?, 'upgrade', ?, ?, NULL, ?, ?, 'human', ?, ?, NULL, NULL)`,
            enrollment.id,
            member.id,
            enrollment.verifier,
            enrollment.keyId,
            nextCeiling,
            currentPrincipal.memberId,
            now,
            addSeconds(now, DEFAULT_ENROLLMENT_SECONDS)
          )
        }
        const seq = this.nextSeq()
        this.audit(
          seq,
          'member.change_role',
          currentPrincipal,
          currentPrincipal.tokenKind,
          'member',
          member.id,
          {
            from: previousRole,
            to: nextRole,
            revoked_token_ids: revokedTokenIds,
            upgrade_enrollment_id: enrollment?.id ?? null,
          }
        )
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'last_active_admin') {
        return jsonError(409, 'last_active_admin')
      }
      if (error instanceof Error && error.message === 'member_changed') {
        return jsonError(409, 'member_changed')
      }
      throw error
    }
    this.closeTokenSessions(revokedTokenIds)
    const live = this.liveUpgrade(member.id)
    return Response.json(
      {
        previous_role: previousRole,
        role: nextRole,
        upgrade_code: enrollment?.credential ?? null,
        pending_intended_access: live?.intended_access ?? null,
        pending_reaches_ceiling: live?.intended_access === nextCeiling,
        human_tokens_below: this.humanTokensBelow(member.id, nextCeiling),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  }

  private handleMembers(url: URL, principal: Principal): Response {
    const pending = url.searchParams.get('pending') === '1'
    const all = url.searchParams.get('all') === '1'
    if (pending && all) return jsonError(422, 'invalid_member_filter')
    if (pending) {
      if (!may(principal, 'invitation.list')) return jsonError(403, 'forbidden')
      const now = isoNow()
      this.expireEnrollments(now, undefined, 'invite')
      const members = this.sql
        .exec(
          `SELECT m.id, m.email, e.intended_role AS role, e.created_by AS invited_by,
                e.created_at, e.expires_at
         FROM members m JOIN enrollments e ON e.member_id = m.id
         WHERE m.status = 'pending' AND e.kind = 'invite' AND e.consumed_at IS NULL
           AND e.revoked_at IS NULL AND e.expires_at > ?
         ORDER BY m.email`,
          now
        )
        .toArray()
      return Response.json({ members })
    }
    if (!may(principal, 'member.list')) return jsonError(403, 'forbidden')
    const profiles = this.memberProfiles().filter(
      (member) => all || member.status === MemberStatus.Active
    )
    return Response.json({ members: profiles })
  }

  private async handleTokenCreate(request: Request, principal: Principal): Promise<Response> {
    if (principal.tokenKind !== TokenKind.Human) {
      return jsonError(403, 'forbidden')
    }
    const body = await requestObject(request)
    if (!body) return jsonError(400, 'invalid_json')
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (invalidTokenName(name)) return jsonError(422, 'invalid_token_name')
    const kind = enumValue<TokenKind>(body.kind ?? TokenKind.Agent, TOKEN_KINDS)
    if (kind === null) return jsonError(422, 'invalid_token_kind')

    let target = this.memberById(principal.memberId)
    let issuedVia = 'self'
    if (body.for_email !== undefined) {
      if (!may(principal, 'token.other.create_agent') || kind !== TokenKind.Agent) {
        return jsonError(403, 'forbidden')
      }
      const email = invalidEmail(body.for_email)
      if (email === null) return jsonError(422, 'invalid_email')
      target = this.memberByEmail(email)
      issuedVia = 'admin_delegation'
    }
    if (!target || target.status !== MemberStatus.Active || target.role === null) {
      return jsonError(409, 'member_not_active')
    }
    let defaultAccess = roleCeiling(target.role)
    if (kind === TokenKind.Agent && defaultAccess === TokenAccess.Admin) {
      defaultAccess = TokenAccess.Write
    }
    const access = enumValue<TokenAccess>(body.access ?? defaultAccess, TOKEN_ACCESS)
    if (access === null || !validTokenAccess(target.role, kind, access)) {
      return jsonError(422, 'invalid_access')
    }
    if (
      target.id === principal.memberId &&
      this.accessRank(access) > this.accessRank(principal.access)
    ) {
      return jsonError(403, 'forbidden')
    }
    const max = kind === TokenKind.Agent ? MAX_AGENT_SECONDS : Number.MAX_SAFE_INTEGER
    const fallback = kind === TokenKind.Agent ? DEFAULT_AGENT_SECONDS : 0
    let expiresIn: number | null = null
    if (body.expires_in_seconds !== undefined || fallback > 0) {
      expiresIn = duration(body.expires_in_seconds, fallback, max)
      if (expiresIn === null) return jsonError(422, 'invalid_expiry')
    }
    const token = await this.prepareCredential('flat_pat')
    const now = isoNow()
    const expiresAt = expiresIn === null || expiresIn === 0 ? null : addSeconds(now, expiresIn)
    try {
      this.ctx.storage.transactionSync(() => {
        const action =
          target.id === principal.memberId ? 'token.self.create' : 'token.other.create_agent'
        const currentPrincipal = this.requireCurrentPrincipal(principal, action)
        const currentTarget = this.memberById(target.id)
        if (
          !currentTarget ||
          currentTarget.status !== MemberStatus.Active ||
          currentTarget.role === null ||
          !validTokenAccess(currentTarget.role, kind, access)
        ) {
          throw new Error('member_changed')
        }
        if (
          currentTarget.id === currentPrincipal.memberId &&
          this.accessRank(access) > this.accessRank(currentPrincipal.access)
        ) {
          throw new PrincipalChangedError(403, 'forbidden')
        }
        this.insertToken(
          token,
          currentTarget.id,
          kind,
          name,
          access,
          currentPrincipal.memberId,
          issuedVia,
          expiresAt,
          now
        )
        const seq = this.nextSeq()
        this.audit(
          seq,
          'token.create',
          currentPrincipal,
          currentPrincipal.tokenKind,
          'token',
          token.id,
          {
            member_id: currentTarget.id,
            kind,
            access,
            issued_via: issuedVia,
          }
        )
      })
    } catch (error) {
      if (error instanceof DuplicateTokenNameError) {
        return jsonError(409, 'duplicate_token_name')
      }
      if (error instanceof Error && error.message === 'member_changed') {
        return jsonError(409, 'member_changed')
      }
      throw error
    }
    return Response.json(
      { token: token.credential, metadata: this.tokenMetadata(token.id) },
      {
        headers: { 'Cache-Control': 'no-store' },
      }
    )
  }

  private handleTokens(url: URL, principal: Principal): Response {
    const all = url.searchParams.get('all') === '1'
    if (all && !may(principal, 'token.other.list')) {
      return jsonError(403, 'forbidden')
    }
    if (!all && !may(principal, 'token.self.list')) {
      return jsonError(403, 'forbidden')
    }
    let query = `SELECT t.id, t.name, t.kind, t.access, m.email AS member, creator.email AS created_by,
                        t.issued_via, t.created_at, t.expires_at, t.last_used_at, t.revoked_at
                 FROM tokens t JOIN members m ON m.id = t.member_id
                 LEFT JOIN members creator ON creator.id = t.created_by`
    const args: unknown[] = []
    if (!all) {
      query += ' WHERE t.member_id = ?'
      args.push(principal.memberId)
    }
    query += ' ORDER BY t.created_at, t.id'
    return Response.json({ tokens: this.sql.exec(query, ...args).toArray() })
  }

  private async handleTokenRevoke(request: Request, principal: Principal): Promise<Response> {
    if (principal.tokenKind !== TokenKind.Human) {
      return jsonError(403, 'forbidden')
    }
    const body = await requestObject(request)
    if (!body || typeof body.token_id !== 'string') {
      return jsonError(422, 'invalid_token_id')
    }
    const tokenId = body.token_id
    const target = this.sql
      .exec<{ id: string; member_id: string; revoked_at: string | null }>(
        'SELECT id, member_id, revoked_at FROM tokens WHERE id = ?',
        tokenId
      )
      .toArray()[0]
    if (!target) return jsonError(404, 'token_not_found')
    const own = target.member_id === principal.memberId
    if (own && !may(principal, 'token.self.revoke')) {
      return jsonError(403, 'forbidden')
    }
    if (!own && !may(principal, 'token.other.revoke')) {
      return jsonError(403, 'forbidden')
    }
    if (target.revoked_at === null) {
      this.ctx.storage.transactionSync(() => {
        const action = own ? 'token.self.revoke' : 'token.other.revoke'
        const currentPrincipal = this.requireCurrentPrincipal(principal, action)
        this.sql.exec('UPDATE tokens SET revoked_at = ? WHERE id = ?', isoNow(), tokenId)
        const seq = this.nextSeq()
        this.audit(
          seq,
          'token.revoke',
          currentPrincipal,
          currentPrincipal.tokenKind,
          'token',
          tokenId,
          {}
        )
      })
      this.closeTokenSessions([tokenId])
    }
    return emptyOk()
  }

  private handleAudit(url: URL, principal: Principal): Response {
    if (!may(principal, 'audit.read')) return jsonError(403, 'forbidden')
    const after = Number(url.searchParams.get('after') ?? '0')
    if (!Number.isSafeInteger(after) || after < 0) {
      return jsonError(422, 'invalid_sequence')
    }
    const events = this.sql
      .exec<{
        id: string
        seq: number
        action: string
        actor_member_id: string | null
        actor_token_id: string | null
        actor_kind: string
        agent_name: string | null
        target_type: string
        target_id: string
        metadata: string
        created_at: string
      }>(
        `SELECT id, seq, action, actor_member_id, actor_token_id, actor_kind, agent_name,
              target_type, target_id, metadata, created_at
       FROM audit_events WHERE seq > ? ORDER BY seq LIMIT 100`,
        after
      )
      .toArray()
      .map((row) => Object.assign({}, row, { metadata: JSON.parse(row.metadata) }))
    return Response.json({ events, latest_seq: this.latestSeq() })
  }

  private insertToken(
    token: PreparedCredential,
    memberId: string,
    kind: TokenKind,
    name: string,
    access: TokenAccess,
    createdBy: string | null,
    issuedVia: string,
    expiresAt: string | null,
    now: string
  ): void {
    this.sql.exec(
      `UPDATE tokens SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL
       AND expires_at IS NOT NULL AND expires_at <= ?`,
      now,
      memberId,
      now
    )
    const duplicate =
      this.sql
        .exec(
          'SELECT 1 FROM tokens WHERE member_id = ? AND lower(name) = lower(?) AND revoked_at IS NULL',
          memberId,
          name
        )
        .toArray().length > 0
    if (duplicate) throw new DuplicateTokenNameError()
    this.sql.exec(
      `INSERT INTO tokens
       (id, member_id, kind, name, access, secret_verifier, verifier_key_id, created_by,
        issued_via, created_at, expires_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      token.id,
      memberId,
      kind,
      name,
      access,
      token.verifier,
      token.keyId,
      createdBy,
      issuedVia,
      now,
      expiresAt
    )
  }

  private tokenMetadata(id: string): Record<string, unknown> | null {
    const row = this.sql
      .exec(
        `SELECT t.id, t.name, t.kind, t.access, m.email AS member, creator.email AS created_by,
              t.issued_via, t.created_at, t.expires_at, t.last_used_at, t.revoked_at
       FROM tokens t JOIN members m ON m.id = t.member_id
       LEFT JOIN members creator ON creator.id = t.created_by WHERE t.id = ?`,
        id
      )
      .toArray()[0]
    return row ? { ...row } : null
  }

  private memberProfiles(): MemberProfile[] {
    return this.sql
      .exec<SqlRow<MemberProfile>>(
        `SELECT id, email, role, status, created_at, activated_at
       FROM members WHERE status != 'pending' ORDER BY email`
      )
      .toArray()
  }

  private memberProfile(id: string): MemberProfile | null {
    return this.memberProfiles().find((member) => member.id === id) ?? null
  }

  private memberByEmail(email: string): MemberRow | null {
    const row = this.sql
      .exec<SqlRow<MemberRow>>('SELECT * FROM members WHERE email = ?', email)
      .toArray()[0]
    return row ?? null
  }

  private memberById(id: string): MemberRow | null {
    const row = this.sql
      .exec<SqlRow<MemberRow>>('SELECT * FROM members WHERE id = ?', id)
      .toArray()[0]
    return row ?? null
  }

  private expireEnrollments(now: string, memberId?: string, kind?: EnrollmentRow['kind']): void {
    let query = `UPDATE enrollments SET revoked_at = ?
                 WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at <= ?`
    const args: unknown[] = [now, now]
    if (memberId !== undefined) {
      query += ' AND member_id = ?'
      args.push(memberId)
    }
    if (kind !== undefined) {
      query += ' AND kind = ?'
      args.push(kind)
    }
    this.sql.exec(query, ...args)
  }

  private liveUpgrade(memberId: string): EnrollmentRow | null {
    const now = isoNow()
    this.expireEnrollments(now, memberId, 'upgrade')
    const row = this.sql
      .exec<SqlRow<EnrollmentRow>>(
        `SELECT e.*, m.status AS member_status, m.role AS member_role
       FROM enrollments e JOIN members m ON m.id = e.member_id
       WHERE e.member_id = ? AND e.kind = 'upgrade' AND e.consumed_at IS NULL AND e.revoked_at IS NULL
      AND e.expires_at > ?`,
        memberId,
        now
      )
      .toArray()[0]
    return row ?? null
  }

  private humanTokensBelow(memberId: string, access: TokenAccess): number {
    return this.sql
      .exec<{ access: TokenAccess }>(
        `SELECT access FROM tokens WHERE member_id = ? AND kind = 'human' AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)`,
        memberId,
        isoNow()
      )
      .toArray()
      .filter((row) => this.accessRank(row.access) < this.accessRank(access)).length
  }

  private activeAdminCount(): number {
    return Number(
      this.sql
        .exec("SELECT COUNT(*) AS count FROM members WHERE status = 'active' AND role = 'admin'")
        .one().count
    )
  }

  private accessRank(access: TokenAccess): number {
    if (access === TokenAccess.Admin) return 2
    if (access === TokenAccess.Write) return 1
    return 0
  }

  private audit(
    seq: number,
    action: string,
    principal: Principal | null,
    actorKind: TokenKind | 'enrollment' | 'deployment' | 'webhook',
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>
  ): void {
    const safeMetadata = { ...metadata }
    if (
      principal?.tokenKind === TokenKind.Agent &&
      principal.createdBy !== null &&
      principal.createdBy !== principal.memberId
    ) {
      safeMetadata.delegated_by_member_id = principal.createdBy
    }
    this.sql.exec(
      `INSERT INTO audit_events
       (id, seq, action, actor_member_id, actor_token_id, actor_kind, agent_name,
        target_type, target_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newUlid(),
      seq,
      action,
      principal?.memberId ?? null,
      principal?.tokenId ?? null,
      actorKind,
      principal?.tokenKind === TokenKind.Agent ? principal.tokenName : null,
      targetType,
      targetId,
      JSON.stringify(safeMetadata),
      isoNow()
    )
  }

  private closeTokenSessions(tokenIds: string[]): void {
    if (tokenIds.length === 0) return
    const revoked = new Set(tokenIds)
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment()
      if (
        isRecord(attachment) &&
        typeof attachment.tokenId === 'string' &&
        revoked.has(attachment.tokenId)
      ) {
        socket.close(4001, 'credential revoked')
      }
    }
  }

  private nextSeq(): number {
    const seq = Number(this.meta('latest_seq')) + 1
    this.setMeta('latest_seq', String(seq))
    return seq
  }

  private log(mutation: Record<string, unknown> | Mutation, seq: number): void {
    this.sql.exec(
      'INSERT INTO mutation_log (seq, mutation_id, entity_id, payload) VALUES (?, ?, ?, ?)',
      seq,
      mutation.mutation_id,
      mutation.entity_id,
      JSON.stringify(mutation)
    )
  }

  private ticketsSince(seq: number): Ticket[] {
    return this.sql
      .exec<SqlRow<Ticket>>(
        'SELECT id, key, title, body, status, seq FROM tickets WHERE seq > ? ORDER BY seq',
        seq
      )
      .toArray()
  }

  private tombstonesSince(seq: number): TicketTombstone[] {
    return this.sql
      .exec<SqlRow<TicketTombstone>>(
        'SELECT id, key, seq FROM ticket_tombstones WHERE seq > ? ORDER BY seq',
        seq
      )
      .toArray()
  }

  private latestSeq(): number {
    return Number(this.meta('latest_seq'))
  }

  private meta(key: string): string {
    return this.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).one().value
  }

  private optionalMeta(key: string): string | null {
    const row = this.sql
      .exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)
      .toArray()[0]
    return row?.value ?? null
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec('UPDATE meta SET value = ? WHERE key = ?', value, key)
  }
}
