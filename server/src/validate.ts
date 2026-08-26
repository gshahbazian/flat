import { z } from 'zod'

export const MAX_COMMENT_BYTES = 1024 * 1024

// Mirrors `flat_schema::validate_title` (schema/src/lib.rs): non-empty,
// single line, no control characters. A newline would corrupt the markdown
// frontmatter every client materializes. Rust checks `char::is_control()`
// (Unicode Cc = U+0000..U+001F and U+007F..U+009F); the regex below is that
// exact range, and schema/fixtures/titles.json is run against both
// implementations in CI so they can't drift apart.
export function invalidTitle(title: string): string | null {
  if (title.trim().length === 0) {
    return 'title must not be empty'
  }
  // oxlint-disable-next-line eslint/no-control-regex -- This intentionally matches Unicode control characters.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(title)) {
    return 'title must be a single line without control characters'
  }
  return null
}

export const titleSchema = z.string().transform((title, context) => {
  const trimmed = title.trim()
  const reason = invalidTitle(trimmed)
  if (reason) {
    context.addIssue({ code: 'custom', message: reason })
    return z.NEVER
  }
  return trimmed
})

// JavaScript trim differs from Rust char::is_whitespace for U+0085 and U+FEFF.
function isRustWhitespace(character: string): boolean {
  const codePoint = character.codePointAt(0)!
  if (codePoint >= 0x09 && codePoint <= 0x0d) return true
  if (codePoint === 0x20 || codePoint === 0x85 || codePoint === 0xa0) return true
  if (codePoint === 0x1680 || (codePoint >= 0x2000 && codePoint <= 0x200a)) return true
  return [0x2028, 0x2029, 0x202f, 0x205f, 0x3000].includes(codePoint)
}

export function invalidCommentBody(body: string): string | null {
  if (Array.from(body).every(isRustWhitespace)) return 'comment must not be empty'
  if (new TextEncoder().encode(body).byteLength > MAX_COMMENT_BYTES) {
    return `comment exceeds the ${MAX_COMMENT_BYTES}-byte limit`
  }
  return null
}

const ASCII_TRIM = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g

export const emailSchema = z
  .string()
  // oxlint-disable-next-line eslint/no-control-regex -- Reject anything outside ASCII, including the control-character range.
  .refine((value) => !/[^\u0000-\u007f]/.test(value))
  .transform((value) => value.replace(ASCII_TRIM, '').toLowerCase())
  // oxlint-disable-next-line eslint/no-control-regex -- Reject ASCII whitespace and control characters.
  .refine((email) => !/[\u0000-\u0020\u007f]/.test(email))
  .refine((email) => {
    const parts = email.split('@')
    if (parts.length !== 2 || parts[0].length === 0) return false
    const labels = parts[1].split('.')
    return labels.length >= 2 && labels.every((label) => label.length > 0)
  })

export function invalidEmail(value: unknown): string | null {
  const result = emailSchema.safeParse(value)
  if (!result.success) return null
  return result.data
}

export const tenantNameSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((name) => name.length > 0 && Array.from(name).length <= 80)

export const projectKeySchema = z.string().regex(/^[A-Z][A-Z0-9]{1,7}$/)

export const projectNameSchema = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (name) =>
      name.length > 0 &&
      Array.from(name).length <= 80 &&
      // oxlint-disable-next-line eslint/no-control-regex -- Project names cannot contain wire-hostile control characters.
      !Array.from(name).some((character) => /[\u0000-\u001f\u007f-\u009f]/.test(character))
  )

export function invalidTenantName(value: unknown): string | null {
  const result = tenantNameSchema.safeParse(value)
  if (!result.success) return null
  return result.data
}

export function invalidTokenName(name: string): boolean {
  return !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
}

export const tokenNameSchema = z
  .string()
  .transform((name) => name.trim())
  .refine((name) => !invalidTokenName(name))
