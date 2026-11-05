export type PullRequestState =
  | 'NOT_CREATED'
  | 'OPEN'
  | 'IN_REVIEW'
  | 'MERGED'
  | 'CLOSED'
  | 'UNKNOWN';

export type DeploymentState =
  | 'NOT_STARTED'
  | 'SYNC_PENDING'
  | 'RECONCILING'
  | 'DEPLOYING'
  | 'READY'
  | 'FAILED'
  | 'UNKNOWN';

export type GitOpsOwnershipState =
  | 'GITOPS_MANAGED'
  | 'API_MANAGED'
  | 'UNKNOWN';

export type GitOpsDiagnosticSource =
  | 'GitHub'
  | 'Flux CD'
  | 'OpenChoreo'
  | 'Backstage backend';

export interface GitOpsStatusDiagnostic {
  source: GitOpsDiagnosticSource;
  reason?: string;
  message: string;
  lastCheckedAt?: string;
}

export interface GitOpsChangeStatus {
  componentName: string;
  environment: string;

  pullRequest: {
    number?: number;
    url?: string;
    state: PullRequestState;
    mergeCommitSha?: string;
    promotedAt?: string;
    isStale?: boolean;
  };

  deployment: {
    state: DeploymentState;
    syncedRevision?: string;
    bindingReady?: boolean;
    statusReason?: string;
    statusMessage?: string;
  };

  diagnostics?: GitOpsStatusDiagnostic[];
  lastCheckedAt?: string;
}

export interface GitOpsTargetCoordinates {
  namespaceName: string;
  projectName: string;
  componentName: string;
  environment: string;
}

export interface GitOpsTargetConfig extends GitOpsTargetCoordinates {
  repositoryProvider: string;
  repositoryOwner: string;
  repositoryName: string;
  repository: string;
  baseBranch: string;
  manifestPath: string;
  updatedAt?: string;
}

export interface GitOpsOwnership {
  namespaceName: string;
  projectName: string;
  componentName: string;
  environment: string;
  ownership: GitOpsOwnershipState;
  repositoryProvider?: string;
  repositoryOwner?: string;
  repositoryName?: string;
  repository?: string;
  baseBranch?: string;
  manifestPath?: string;
  repositoryConfigured?: boolean;
  updatedAt?: string;
}
