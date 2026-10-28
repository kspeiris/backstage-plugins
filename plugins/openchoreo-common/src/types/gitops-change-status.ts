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
