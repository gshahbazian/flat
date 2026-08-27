import { createHmac } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'

const HMAC_KEY = Buffer.alloc(32, 31)
const HMAC_SECRET = HMAC_KEY.toString('base64url')
const SETUP_CREDENTIAL = `flat_setup_${Buffer.alloc(32, 32).toString('base64url')}`
const OPERATOR_CREDENTIAL = `flat_oprec_${Buffer.alloc(32, 33).toString('base64url')}`
const WRONG_OPERATOR_CREDENTIAL = `flat_oprec_${Buffer.alloc(32, 34).toString('base64url')}`
const SETUP_VERIFIER = verifier(SETUP_CREDENTIAL)
const OPERATOR_VERIFIER = verifier(OPERATOR_CREDENTIAL)

type WorkerRequestInit = NonNullable<Parameters<Unstable_DevWorker['fetch']>[1]>
type WorkerResponse = Awaited<ReturnType<Unstable_DevWorker['fetch']>>

interface JsonResponse<T> {
  response: WorkerResponse
  body: T
}

interface TokenResponse {
  token: string
}

function verifier(credential: string): string {
  return createHmac('sha256', HMAC_KEY).update(credential).digest('hex')
}

async function startWorker(operatorVerifier?: string): Promise<Unstable_DevWorker> {
  const vars: Record<string, string> = {
    FLAT_HMAC_KEYS: JSON.stringify([{ id: 'test', secret: HMAC_SECRET }]),
    FLAT_SETUP_VERIFIER: `test:${SETUP_VERIFIER}`,
  }
  if (operatorVerifier !== undefined) {
    vars.FLAT_OPERATOR_RECOVERY_VERIFIER = `test:${operatorVerifier}`
  }
  return unstable_dev('src/index.ts', {
    config: 'wrangler.jsonc',
    persist: false,
    logLevel: 'error',
    vars,
    experimental: {
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      watch: false,
    },
  })
}

async function json<T>(
  worker: Unstable_DevWorker,
  path: string,
  init: WorkerRequestInit = {}
): Promise<JsonResponse<T>> {
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value
  })
  if (init.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json'
  }
  const response = await worker.fetch(`http://flat.test${path}`, { ...init, headers })
  const text = await response.text()
  return {
    response,
    body: text.length > 0 ? (JSON.parse(text) as T) : (null as T),
  }
}

function post(body: unknown): WorkerRequestInit {
  return { method: 'POST', body: JSON.stringify(body) }
}

function authenticated(token: string, body?: unknown): WorkerRequestInit {
  const init: WorkerRequestInit = {
    headers: { Authorization: `Bearer ${token}` },
  }
  if (body !== undefined) {
    init.method = 'POST'
    init.body = JSON.stringify(body)
  }
  return init
}

async function setup(worker: Unstable_DevWorker): Promise<TokenResponse> {
  const result = await json<TokenResponse>(
    worker,
    '/setup',
    post({
      setup_credential: SETUP_CREDENTIAL,
      email: 'target-admin@example.com',
      tenant_name: 'Recovery test tenant',
      token_name: 'target-admin-cli',
    })
  )
  expect(result.response.status).toBe(200)
  return result.body
}

async function inviteAndEnroll(
  worker: Unstable_DevWorker,
  adminToken: string,
  email: string,
  role: 'admin' | 'member'
): Promise<string> {
  const invitation = await json<{ invitation_code: string }>(
    worker,
    '/members/invite',
    authenticated(adminToken, { email, role })
  )
  expect(invitation.response.status).toBe(200)
  const enrollment = await json<TokenResponse>(
    worker,
    '/enroll/invite',
    post({ credential: invitation.body.invitation_code, token_name: `${role}-cli` })
  )
  expect(enrollment.response.status).toBe(200)
  return enrollment.body.token
}

describe.sequential('operator recovery without a configured verifier', () => {
  let worker: Unstable_DevWorker

  beforeAll(async () => {
    worker = await startWorker()
    await setup(worker)
  }, 30_000)

  afterAll(async () => {
    await worker.stop()
  })

  test('dummy-verifies and returns the same unauthorized response as a wrong secret', async () => {
    const missingVerifier = await json<{ error: string }>(
      worker,
      '/operator/recover',
      post({
        operator_credential: OPERATOR_CREDENTIAL,
        email: 'target-admin@example.com',
      })
    )
    const anotherSecret = await json<{ error: string }>(
      worker,
      '/operator/recover',
      post({
        operator_credential: WRONG_OPERATOR_CREDENTIAL,
        email: 'target-admin@example.com',
      })
    )

    expect(missingVerifier.response.status).toBe(401)
    expect(anotherSecret.response.status).toBe(401)
    expect(missingVerifier.body).toEqual({ error: 'invalid_operator_recovery' })
    expect(anotherSecret.body).toEqual(missingVerifier.body)
  })
})

describe.sequential('operator recovery with a configured verifier', () => {
  let worker: Unstable_DevWorker
  let targetToken: string
  let helperAdminToken: string

  beforeAll(async () => {
    worker = await startWorker(OPERATOR_VERIFIER)
  }, 30_000)

  afterAll(async () => {
    await worker.stop()
  })

  test('requires initialized tenant state before checking the operator credential', async () => {
    const response = await json<{ error: string }>(
      worker,
      '/operator/recover',
      post({
        operator_credential: OPERATOR_CREDENTIAL,
        email: 'target-admin@example.com',
      })
    )
    expect(response.response.status).toBe(409)
    expect(response.body.error).toBe('setup_required')

    targetToken = (await setup(worker)).token
  })

  test('rejects a wrong secret and every target that is not an active admin', async () => {
    helperAdminToken = await inviteAndEnroll(
      worker,
      targetToken,
      'helper-admin@example.com',
      'admin'
    )
    await inviteAndEnroll(worker, targetToken, 'member@example.com', 'member')
    await inviteAndEnroll(worker, targetToken, 'inactive-admin@example.com', 'admin')
    const suspension = await json(
      worker,
      '/members/suspend',
      authenticated(targetToken, { email: 'inactive-admin@example.com' })
    )
    expect(suspension.response.status).toBe(200)

    const wrong = await json<{ error: string }>(
      worker,
      '/operator/recover',
      post({
        operator_credential: WRONG_OPERATOR_CREDENTIAL,
        email: 'target-admin@example.com',
      })
    )
    expect(wrong.response.status).toBe(401)
    expect(wrong.body.error).toBe('invalid_operator_recovery')

    const invalidTargets = await Promise.all(
      ['member@example.com', 'inactive-admin@example.com', 'unknown@example.com'].map((email) =>
        json<{ error: string }>(
          worker,
          '/operator/recover',
          post({ operator_credential: OPERATOR_CREDENTIAL, email })
        )
      )
    )
    for (const invalidTarget of invalidTargets) {
      expect(invalidTarget.response.status).toBe(409)
      expect(invalidTarget.body.error).toBe('operator_recovery_target_invalid')
    }
  })

  test('works once, revokes credentials, preserves tenant state, and redeems as admin', async () => {
    const olderRecovery = await json<{ recovery_code: string }>(
      worker,
      '/members/recover',
      authenticated(helperAdminToken, { email: 'target-admin@example.com' })
    )
    expect(olderRecovery.response.status).toBe(200)

    const delegated = await json<{
      token: string
      metadata: { id: string }
    }>(
      worker,
      '/tokens',
      authenticated(helperAdminToken, {
        name: 'target-recovery-agent',
        kind: 'agent',
        access: 'write',
        for_email: 'target-admin@example.com',
      })
    )
    expect(delegated.response.status).toBe(200)
    expect(
      (await json(worker, '/snapshot', authenticated(delegated.body.token))).response.status
    ).toBe(200)

    const requestedAt = Date.now()
    const attempts = await Promise.all(
      [0, 1].map(() =>
        json<{ recovery_code?: string; expires_at?: string; error?: string }>(
          worker,
          '/operator/recover',
          post({
            operator_credential: OPERATOR_CREDENTIAL,
            email: 'target-admin@example.com',
          })
        )
      )
    )
    expect(
      attempts.map((attempt) => attempt.response.status).toSorted((left, right) => left - right)
    ).toEqual([200, 401])
    const successful = attempts.find((attempt) => attempt.response.status === 200)
    expect(successful).toBeDefined()
    expect(successful?.body.recovery_code).toMatch(/^flat_rec_[0-9A-HJKMNP-TV-Z]{26}_/)
    expect(successful?.response.headers.get('cache-control')).toBe('no-store')
    const expiresAt = Date.parse(successful?.body.expires_at ?? '')
    expect(expiresAt - requestedAt).toBeGreaterThanOrEqual(899_000)
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(900_000)

    const replay = await json<{ error: string }>(
      worker,
      '/operator/recover',
      post({
        operator_credential: OPERATOR_CREDENTIAL,
        email: 'target-admin@example.com',
      })
    )
    expect(replay.response.status).toBe(401)
    expect(replay.body.error).toBe('invalid_operator_recovery')

    expect(
      (await json(worker, '/snapshot', authenticated(delegated.body.token))).response.status
    ).toBe(401)
    const revokedRecovery = await json<{ error: string }>(
      worker,
      '/enroll/recover',
      post({ credential: olderRecovery.body.recovery_code, token_name: 'stale-recovery-cli' })
    )
    expect(revokedRecovery.response.status).toBe(410)
    expect(revokedRecovery.body.error).toBe('enrollment_revoked')

    const setupReplay = await json<{ error: string }>(
      worker,
      '/setup',
      post({
        setup_credential: SETUP_CREDENTIAL,
        email: 'replacement@example.com',
        tenant_name: 'Replacement tenant',
        token_name: 'replacement-cli',
      })
    )
    expect(setupReplay.response.status).toBe(409)
    expect(setupReplay.body.error).toBe('setup_already_completed')

    const redeemed = await json<TokenResponse>(
      worker,
      '/enroll/recover',
      post({ credential: successful?.body.recovery_code, token_name: 'recovered-admin-cli' })
    )
    expect(redeemed.response.status).toBe(200)
    const snapshot = await json(worker, '/snapshot', authenticated(redeemed.body.token))
    expect(snapshot.response.status).toBe(200)
    const members = await json<{
      members: Array<{ email: string; role: string; status: string }>
    }>(worker, '/members?all=1', authenticated(redeemed.body.token))
    expect(members.body.members).toContainEqual(
      expect.objectContaining({
        email: 'target-admin@example.com',
        role: 'admin',
        status: 'active',
      })
    )

    const audit = await json<{
      events: Array<{
        action: string
        actor_kind: string
        actor_member_id: string | null
        actor_token_id: string | null
        metadata: { revoked_token_ids?: string[] }
      }>
    }>(worker, '/audit', authenticated(redeemed.body.token))
    const operatorEvent = audit.body.events.find(
      (event) =>
        event.action === 'member.recover' &&
        event.actor_kind === 'deployment' &&
        event.metadata.revoked_token_ids?.includes(delegated.body.metadata.id)
    )
    expect(operatorEvent).toEqual(
      expect.objectContaining({
        actor_member_id: null,
        actor_token_id: null,
        actor_kind: 'deployment',
      })
    )
    expect(JSON.stringify(operatorEvent)).not.toContain('flat_oprec_')
    expect(JSON.stringify(operatorEvent)).not.toContain('flat_rec_')
  }, 30_000)
})

describe.sequential('operator recovery enrollment revocation', () => {
  let worker: Unstable_DevWorker

  beforeAll(async () => {
    worker = await startWorker(OPERATOR_VERIFIER)
  }, 30_000)

  afterAll(async () => {
    await worker.stop()
  })

  test('revokes a live upgrade enrollment through the shared recovery transaction', async () => {
    const target = await setup(worker)
    const helperAdminToken = await inviteAndEnroll(
      worker,
      target.token,
      'upgrade-helper@example.com',
      'admin'
    )

    const demotion = await json(
      worker,
      '/members/role',
      authenticated(helperAdminToken, { email: 'target-admin@example.com', role: 'member' })
    )
    expect(demotion.response.status).toBe(200)

    const memberRecovery = await json<{ recovery_code: string }>(
      worker,
      '/members/recover',
      authenticated(helperAdminToken, { email: 'target-admin@example.com' })
    )
    expect(memberRecovery.response.status).toBe(200)
    const memberToken = await json<TokenResponse>(
      worker,
      '/enroll/recover',
      post({ credential: memberRecovery.body.recovery_code, token_name: 'member-recovery-cli' })
    )
    expect(memberToken.response.status).toBe(200)

    const promotion = await json<{ upgrade_code: string }>(
      worker,
      '/members/role',
      authenticated(helperAdminToken, { email: 'target-admin@example.com', role: 'admin' })
    )
    expect(promotion.response.status).toBe(200)
    expect(promotion.body.upgrade_code).toMatch(/^flat_upg_[0-9A-HJKMNP-TV-Z]{26}_/)

    const operatorRecovery = await json<{ recovery_code: string }>(
      worker,
      '/operator/recover',
      post({
        operator_credential: OPERATOR_CREDENTIAL,
        email: 'target-admin@example.com',
      })
    )
    expect(operatorRecovery.response.status).toBe(200)

    const recoveredAdmin = await json<TokenResponse>(
      worker,
      '/enroll/recover',
      post({ credential: operatorRecovery.body.recovery_code, token_name: 'operator-recovery-cli' })
    )
    expect(recoveredAdmin.response.status).toBe(200)

    const revokedUpgrade = await json<{ error: string }>(
      worker,
      '/tokens/upgrade',
      authenticated(recoveredAdmin.body.token, { upgrade_code: promotion.body.upgrade_code })
    )
    expect(revokedUpgrade.response.status).toBe(410)
    expect(revokedUpgrade.body.error).toBe('enrollment_revoked')

    expect(
      (await json(worker, '/snapshot', authenticated(memberToken.body.token))).response.status
    ).toBe(401)
  }, 30_000)
})
