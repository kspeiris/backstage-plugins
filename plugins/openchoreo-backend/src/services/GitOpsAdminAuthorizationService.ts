import { InputError, NotAllowedError } from '@backstage/errors';
import type { Config } from '@backstage/config';

export interface GitOpsUserPrincipal {
  userEntityRef?: string;
  ownershipEntityRefs?: string[];
}

const normalizeEntityRef = (
  value: string,
  expectedKind: 'user' | 'group',
): string => {
  const normalized = value.trim().toLocaleLowerCase('en-US');
  if (
    !normalized.startsWith(`${expectedKind}:`) ||
    !/^(user|group):[^/\s]+\/[^/\s]+$/.test(normalized)
  ) {
    throw new InputError(
      `GitOps admin entries must be fully qualified ${expectedKind} entity references`,
    );
  }
  return normalized;
};

export class GitOpsAdminAuthorizationService {
  private readonly adminEntityRefs: Set<string>;

  constructor(users: string[], groups: string[]) {
    this.adminEntityRefs = new Set([
      ...users.map(user => normalizeEntityRef(user, 'user')),
      ...groups.map(group => normalizeEntityRef(group, 'group')),
    ]);
  }

  isAdmin(principal: GitOpsUserPrincipal): boolean {
    const principalRefs = [
      ...(principal.userEntityRef ? [principal.userEntityRef] : []),
      ...(Array.isArray(principal.ownershipEntityRefs)
        ? principal.ownershipEntityRefs
        : []),
    ].map(ref => ref.toLocaleLowerCase('en-US'));

    return principalRefs.some(ref => this.adminEntityRefs.has(ref));
  }

  assertAdmin(principal: GitOpsUserPrincipal): void {
    if (!this.isAdmin(principal)) {
      throw new NotAllowedError(
        'Only configured GitOps administrators may change ownership mappings or repository configuration',
      );
    }
  }
}

export function createGitOpsAdminAuthorizationService(
  config: Config | undefined,
): GitOpsAdminAuthorizationService {
  const adminsConfig = config?.getOptionalConfig('admins');
  return new GitOpsAdminAuthorizationService(
    adminsConfig?.getOptionalStringArray('users') ?? [],
    adminsConfig?.getOptionalStringArray('groups') ?? [],
  );
}
