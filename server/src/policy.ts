import { Role, TokenAccess, TokenKind } from './schema.gen'

export const ACTIONS = [
  'work.read',
  'work.search',
  'ticket.create',
  'ticket.update',
  'ticket.delete',
  'comment.create',
  'label.create',
  'label.update',
  'label.delete',
  'project.create',
  'project.update',
  'project.delete',
  'project_owner.update',
  'member.list',
  'member.invite',
  'member.cancel',
  'member.recover',
  'member.upgrade',
  'member.suspend',
  'member.reactivate',
  'member.change_role',
  'invitation.list',
  'token.self.list',
  'token.self.create',
  'token.self.revoke',
  'token.self.upgrade',
  'token.other.list',
  'token.other.revoke',
  'token.other.create_agent',
  'integration.github.manage',
  'audit.read',
] as const

export type Action = (typeof ACTIONS)[number]

export interface Principal {
  memberId: string
  email: string
  role: Role
  tokenId: string
  tokenKind: TokenKind
  tokenName: string
  access: TokenAccess
  createdBy: string | null
}
const ACCESS_RANK: Record<TokenAccess, number> = {
  [TokenAccess.Read]: 0,
  [TokenAccess.Write]: 1,
  [TokenAccess.Admin]: 2,
}

export function roleCeiling(role: Role): TokenAccess {
  if (role === Role.Admin) return TokenAccess.Admin
  if (role === Role.Member) return TokenAccess.Write
  return TokenAccess.Read
}

export function accessAtLeast(actual: TokenAccess, required: TokenAccess): boolean {
  return ACCESS_RANK[actual] >= ACCESS_RANK[required]
}

export function may(
  principal: Principal,
  action: Action,
  resource: { ownerIds?: string[]; targetMemberId?: string } = {}
): boolean {
  if (action === 'work.read' || action === 'work.search' || action === 'member.list') {
    return accessAtLeast(principal.access, TokenAccess.Read)
  }

  const ownTokenAction = action.startsWith('token.self.')
  if (ownTokenAction) return principal.tokenKind === TokenKind.Human

  const adminActions: Action[] = [
    'ticket.delete',
    'label.delete',
    'project.delete',
    'member.invite',
    'member.cancel',
    'member.recover',
    'member.upgrade',
    'member.suspend',
    'member.reactivate',
    'member.change_role',
    'invitation.list',
    'token.other.list',
    'token.other.revoke',
    'token.other.create_agent',
    'integration.github.manage',
    'audit.read',
  ]
  if (adminActions.includes(action)) {
    return (
      principal.role === Role.Admin &&
      principal.tokenKind === TokenKind.Human &&
      principal.access === TokenAccess.Admin
    )
  }

  if (action === 'project.update' || action === 'project_owner.update') {
    if (!accessAtLeast(principal.access, TokenAccess.Write)) return false
    if (principal.role === Role.Admin) return true
    return (
      principal.role === Role.Member && resource.ownerIds?.includes(principal.memberId) === true
    )
  }

  return principal.role !== Role.Viewer && accessAtLeast(principal.access, TokenAccess.Write)
}

export function validTokenAccess(role: Role, kind: TokenKind, access: TokenAccess): boolean {
  if (kind === TokenKind.Agent && access === TokenAccess.Admin) return false
  return accessAtLeast(roleCeiling(role), access)
}
