import { z } from 'zod'

const KEY = '[A-Z][A-Z0-9]{1,7}-\\d+'
const KEY_CASE_INSENSITIVE = '[A-Za-z][A-Za-z0-9]{1,7}-\\d+'
const VALID_KEY = new RegExp(`^${KEY}$`)
const KEY_AT_START = new RegExp(`^(${KEY})(?=$|[\\s,.;:!?)\\] }])`)
const PHRASE = new RegExp(
  `\\b(?:close|closes|closed|closing|fix|fixes|fixed|fixing|resolve|resolves|resolved|resolving|complete|completes|completed|completing)(?::)?[ \\t]+(${KEY_CASE_INSENSITIVE})(?=$|[\\s,.;:!?)\\] }])`,
  'gi'
)

export const githubPayloadSchema = z.looseObject({
  action: z.unknown().optional(),
})

export const githubMergeTargetSchema = z.looseObject({
  pull_request: z.looseObject({
    merged: z.boolean(),
    base: z.looseObject({ ref: z.string() }),
  }),
  repository: z.looseObject({ default_branch: z.string() }),
})

const githubPullRequestSchema = z
  .looseObject({
    number: z.unknown().optional(),
    pull_request: z.looseObject({
      number: z.unknown().optional(),
      title: z.string().max(1024),
      body: z.string().nullable().optional(),
      merged: z.literal(true),
      html_url: z.string().max(2048),
      base: z.looseObject({ ref: z.string().max(255) }),
    }),
    repository: z.looseObject({
      full_name: z.string().max(256),
      default_branch: z.string().max(255),
    }),
  })
  .transform((payload) => ({
    pullNumber: payload.pull_request.number ?? payload.number,
    title: payload.pull_request.title,
    body: payload.pull_request.body ?? null,
    url: payload.pull_request.html_url,
    baseRef: payload.pull_request.base.ref,
    repository: payload.repository.full_name,
    defaultBranch: payload.repository.default_branch,
  }))

export const relevantGithubPullRequestSchema = githubPullRequestSchema.pipe(
  z.object({
    pullNumber: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    url: z.string(),
    baseRef: z.string(),
    repository: z.string(),
    defaultBranch: z.string(),
  })
)

function stripMarkdown(value: string): string {
  let text = value.replace(/<!--[\s\S]*?-->/g, '')
  const lines = text.split(/\r?\n/)
  let fence: { marker: '`' | '~'; length: number } | null = null
  const kept: string[] = []
  for (const line of lines) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const rawMarker = fenceMatch[1][0]
      if (rawMarker !== '`' && rawMarker !== '~') continue
      const marker = rawMarker
      const length = fenceMatch[1].length
      if (fence === null) fence = { marker, length }
      else if (fence.marker === marker && length >= fence.length) fence = null
      kept.push('')
      continue
    }
    if (fence !== null || /^(?: {4,}|\t)/.test(line) || /^\s*>/.test(line)) {
      kept.push('')
      continue
    }
    kept.push(line)
  }
  text = kept.join('\n')
  text = text.replace(/!\[[^\]]*\]\([^\n)]*\)/g, '')
  text = text.replace(/\[([^\]]+)\]\([^\n)]*\)/g, '$1')
  text = text.replace(/`+[^`\n]*`+/g, '')
  return text
}

function keysInField(value: string): string[] {
  const text = stripMarkdown(value)
  const keys: string[] = []
  for (const match of text.matchAll(PHRASE)) {
    if (!VALID_KEY.test(match[1])) continue
    keys.push(match[1])
    let rest = text.slice((match.index ?? 0) + match[0].length)
    while (true) {
      const separator = rest.match(/^(?:(?:[ \t]*,[ \t]*(?:and[ \t]+)?)|(?:[ \t]+and[ \t]+))+/i)
      if (!separator) break
      rest = rest.slice(separator[0].length)
      const next = rest.match(KEY_AT_START)
      if (!next) break
      keys.push(next[1])
      rest = rest.slice(next[1].length)
    }
  }
  return keys
}

export function closingTicketKeys(title: string, body: string | null): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const key of [...keysInField(title), ...keysInField(body ?? '')]) {
    if (seen.has(key)) continue
    seen.add(key)
    result.push(key)
  }
  return result
}

export async function verifyGithubSignature(
  secret: string,
  body: ArrayBuffer,
  header: string | null
): Promise<boolean> {
  if (!header || !/^sha256=[0-9a-fA-F]{64}$/.test(header)) return false
  const expected = Uint8Array.from(header.slice(7).match(/.{2}/g) ?? [], (pair) =>
    Number.parseInt(pair, 16)
  )
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  return crypto.subtle.verify('HMAC', key, expected, body)
}
