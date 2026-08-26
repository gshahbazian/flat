import { z } from 'zod'

import { Role, TokenAccess, TokenKind } from './schema.gen'
import { emailSchema, tenantNameSchema, tokenNameSchema } from './validate'
import { roleSchema } from './wire-schema'

export const jsonObjectSchema = z.looseObject({})
export const stringValueSchema = z.string()

export function durationSchema(maximum: number) {
  return z.number().int().positive().max(maximum)
}

function defaulted<T extends string>(schema: z.ZodType<T>, fallback: T) {
  return z.preprocess((value) => value ?? undefined, schema.optional().default(fallback))
}

export const setupBodySchema = z
  .object({
    setup_credential: z.unknown().optional(),
    credential: z.unknown().optional(),
    email: z.unknown().optional(),
    admin_email: z.unknown().optional(),
    tenant_name: z.unknown().optional(),
    display_name: z.unknown().optional(),
    token_name: z.unknown().optional(),
    cli_name: z.unknown().optional(),
    name: z.unknown().optional(),
  })
  .transform((body) => ({
    credential: body.setup_credential ?? body.credential,
    email: body.email ?? body.admin_email,
    tenantName: body.tenant_name ?? body.display_name,
    tokenName: body.token_name ?? body.cli_name ?? body.name,
  }))

export const setupIdentitySchema = z.object({
  email: emailSchema,
  tenantName: tenantNameSchema,
  tokenName: tokenNameSchema,
})

export const invitationMemberSchema = z.object({
  email: emailSchema,
  role: defaulted(roleSchema, Role.Member),
})

export const bulkInvitationMarkerSchema = z.object({ members: z.array(z.unknown()) })

export function bulkInvitationSchema(defaultSeconds: number, maximumSeconds: number) {
  return z
    .object({
      members: z.array(invitationMemberSchema).min(1),
      expires_in_seconds: durationSchema(maximumSeconds).optional().default(defaultSeconds),
    })
    .superRefine((body, context) => {
      const emails = new Set<string>()
      for (const member of body.members) {
        if (emails.has(member.email)) {
          context.addIssue({
            code: 'custom',
            path: ['members'],
            message: 'duplicate email',
          })
          return
        }
        emails.add(member.email)
      }
    })
}

export function invitationSchema(defaultSeconds: number, maximumSeconds: number) {
  return z.object({
    email: emailSchema,
    role: defaulted(roleSchema, Role.Member),
    expires_in_seconds: durationSchema(maximumSeconds).optional().default(defaultSeconds),
  })
}

export function enrollmentBodySchema(kind: 'invite' | 'recovery') {
  return z
    .object({
      credential: z.unknown().optional(),
      invitation_code: z.unknown().optional(),
      recovery_code: z.unknown().optional(),
      token_name: z.unknown().optional(),
      cli_name: z.unknown().optional(),
      name: z.unknown().optional(),
    })
    .transform((body) => {
      let credential = body.credential ?? body.recovery_code
      if (kind === 'invite') credential = body.credential ?? body.invitation_code
      return {
        credential,
        tokenName: body.token_name ?? body.cli_name ?? body.name,
      }
    })
}

export const emailBodySchema = z.object({ email: emailSchema })

export const operatorRecoveryBodySchema = z
  .object({
    operator_credential: z.unknown().optional(),
    credential: z.unknown().optional(),
    email: z.unknown().optional(),
  })
  .transform((body) => ({
    credential: body.operator_credential ?? body.credential,
    email: body.email,
  }))

export const upgradeCreationBodySchema = z.object({
  email: emailSchema,
  replace: z.boolean().catch(false).optional().default(false),
})

export const tokenUpgradeBodySchema = z
  .object({
    credential: z.unknown().optional(),
    upgrade_code: z.unknown().optional(),
  })
  .transform((body) => ({ credential: body.credential ?? body.upgrade_code }))

export const memberRoleBodySchema = z.object({
  email: emailSchema,
  role: roleSchema,
})

export const tokenKindSchema = z.enum(TokenKind)
export const tokenAccessSchema = z.enum(TokenAccess)

export const tokenCreateBodySchema = z.object({
  name: tokenNameSchema,
  kind: defaulted(tokenKindSchema, TokenKind.Agent),
  for_email: z.unknown().optional(),
  access: z.unknown().optional(),
  expires_in_seconds: z.unknown().optional(),
})

export const tokenRevokeBodySchema = z.object({ token_id: z.string() })

export const socketAttachmentSchema = z.object({ tokenId: z.string() })
