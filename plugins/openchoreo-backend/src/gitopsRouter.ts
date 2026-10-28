import { InputError } from '@backstage/errors';
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { EnvironmentInfoService } from './services/EnvironmentService/EnvironmentInfoService';
import type { GitOpsChangeTrackerService } from './services/GitOpsChangeTrackerService';
import express from 'express';
import Router from 'express-promise-router';
import {
  OpenChoreoTokenService,
  createUserTokenMiddleware,
  getUserTokenFromRequest,
  createRequireAuthMiddleware,
} from '@openchoreo/openchoreo-auth';
import type { GitOpsStatusDiagnostic } from '@openchoreo/backstage-plugin-common';

function getDeploymentDiagnosticSource(
  reason?: string,
  message?: string,
): GitOpsStatusDiagnostic['source'] {
  return /\bflux(?:cd)?\b/i.test(`${reason ?? ''} ${message ?? ''}`)
    ? 'Flux CD'
    : 'OpenChoreo';
}

function sanitizeDiagnosticMessage(message: string): string {
  return message.replace(
    /\b(authorization|proxy-authorization|bearer|token|password|secret|client_secret)\b\s*[:=]\s*(?:(?:bearer|token)\s+)?[^\s,;]+/gi,
    '$1=[REDACTED]',
  );
}

function requiredQueryString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InputError(`${name} is required query parameter`);
  }
  return value.trim();
}

function requiredBodyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InputError(`${name} is required in request body`);
  }
  return value.trim();
}

function parseRepositoryUrl(value: unknown): {
  owner: string;
  name: string;
} {
  const repositoryUrl = requiredBodyString(value, 'repositoryUrl');
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    throw new InputError('repositoryUrl must be a GitHub repository URL');
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.username ||
    url.password ||
    parts.length !== 2 ||
    url.search ||
    url.hash
  ) {
    throw new InputError('repositoryUrl must be https://github.com/OWNER/REPO');
  }

  return {
    owner: parts[0],
    name: parts[1].replace(/\.git$/, ''),
  };
}

function parsePullRequestUrl(
  value: unknown,
  repository: { owner: string; name: string },
): number {
  const pullRequestUrl = requiredBodyString(value, 'pullRequestUrl');
  let url: URL;
  try {
    url = new URL(pullRequestUrl);
  } catch {
    throw new InputError('pullRequestUrl must be a GitHub pull request URL');
  }

  const parts = url.pathname.split('/').filter(Boolean);
  const pullRequestNumber = Number(parts[3]);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    parts.length !== 4 ||
    parts[2] !== 'pull' ||
    !/^[1-9]\d*$/.test(parts[3]) ||
    !Number.isSafeInteger(pullRequestNumber) ||
    parts[0].toLowerCase() !== repository.owner.toLowerCase() ||
    parts[1].replace(/\.git$/, '').toLowerCase() !==
      repository.name.toLowerCase()
  ) {
    throw new InputError(
      'pullRequestUrl must identify a pull request in repositoryUrl',
    );
  }

  return pullRequestNumber;
}

export async function createGitOpsRouter({
  trackerService,
  environmentInfoService,
  tokenService,
  authEnabled,
  logger,
}: {
  trackerService: GitOpsChangeTrackerService;
  environmentInfoService: EnvironmentInfoService;
  tokenService: OpenChoreoTokenService;
  authEnabled: boolean;
  logger: LoggerService;
}): Promise<express.Router> {
  const router = Router();
  router.use(express.json());
  router.use(createUserTokenMiddleware(tokenService));
  const requireAuth = createRequireAuthMiddleware(tokenService, authEnabled);

  router.post('/gitops/promotions', requireAuth, async (req, res) => {
    const repository = parseRepositoryUrl(req.body?.repositoryUrl);
    const pullRequestNumber = parsePullRequestUrl(
      req.body?.pullRequestUrl,
      repository,
    );

    await trackerService.recordPromotion({
      namespaceName: requiredBodyString(
        req.body?.namespaceName,
        'namespaceName',
      ),
      projectName: requiredBodyString(req.body?.projectName, 'projectName'),
      componentName: requiredBodyString(
        req.body?.componentName,
        'componentName',
      ),
      environment: requiredBodyString(req.body?.environment, 'environment'),
      repositoryOwner: repository.owner,
      repositoryName: repository.name,
      pullRequestNumber,
    });

    res.status(201).json({ success: true });
  });

  router.get('/gitops/status', async (req, res) => {
    const projectName = requiredQueryString(req.query.project, 'project');
    const componentName = requiredQueryString(req.query.component, 'component');
    const environmentName = requiredQueryString(
      req.query.environment,
      'environment',
    );
    const namespaceParam = req.query.namespace ?? req.query.namespaceName;
    if (namespaceParam !== undefined && typeof namespaceParam !== 'string') {
      throw new InputError('namespace must be a single string');
    }
    const namespaceName =
      typeof namespaceParam === 'string' ? namespaceParam.trim() : 'default';
    if (!namespaceName) {
      throw new InputError('namespace must not be empty');
    }

    const diagnostics: GitOpsStatusDiagnostic[] = [];
    let pullRequest;
    try {
      pullRequest = await trackerService.getPullRequestStatus({
        namespaceName,
        projectName,
        componentName,
        environment: environmentName,
      });
    } catch (error) {
      logger.error(
        `Failed to retrieve GitHub pull request status for ${namespaceName}/${projectName}/${componentName} in ${environmentName}`,
        error instanceof Error ? error : new Error(String(error)),
      );
      diagnostics.push({
        source: 'Backstage backend',
        reason: 'GitHubStatusUnavailable',
        message:
          'The backend could not retrieve pull request status. Refresh to try again.',
        lastCheckedAt: new Date().toISOString(),
      });
      pullRequest = { state: 'UNKNOWN' as const };
    }

    let environment;
    try {
      const environments = await environmentInfoService.fetchDeploymentInfo(
        {
          namespaceName,
          projectName,
          componentName,
        },
        getUserTokenFromRequest(req),
      );
      environment = environments.find(
        item =>
          item.name === environmentName ||
          item.resourceName === environmentName,
      );
    } catch (error) {
      logger.error(
        `Failed to retrieve deployment status for ${namespaceName}/${projectName}/${componentName} in ${environmentName}`,
        error instanceof Error ? error : new Error(String(error)),
      );
      diagnostics.push({
        source: 'Backstage backend',
        reason: 'DeploymentStatusUnavailable',
        message:
          'The backend could not retrieve deployment status. Refresh to try again.',
        lastCheckedAt: new Date().toISOString(),
      });
    }

    const bindingReady = environment?.deployment.status === 'Ready';
    const deploymentState = diagnostics.some(
      diagnostic => diagnostic.reason === 'DeploymentStatusUnavailable',
    )
      ? 'UNKNOWN'
      : !environment?.bindingName
      ? pullRequest.state === 'MERGED'
        ? 'SYNC_PENDING'
        : 'NOT_STARTED'
      : environment.deployment.status === 'Ready'
      ? 'READY'
      : environment.deployment.status === 'Failed'
      ? 'FAILED'
      : environment.deployment.status === 'NotReady'
      ? 'DEPLOYING'
      : 'RECONCILING';

    if (pullRequest.isStale && pullRequest.number !== undefined) {
      diagnostics.push({
        source: 'GitHub',
        reason: 'PullRequestStatusStale',
        message:
          'GitHub could not be reached. The pull request state shown is the last known state.',
        lastCheckedAt: pullRequest.lastCheckedAt,
      });
    }

    if (deploymentState === 'FAILED') {
      const rawMessage =
        environment?.deployment.statusMessage ??
        environment?.deployment.statusReason ??
        'The OpenChoreo deployment controller reported a failure.';
      diagnostics.push({
        source: getDeploymentDiagnosticSource(
          environment.deployment.statusReason,
          rawMessage,
        ),
        reason: environment?.deployment.statusReason,
        message: sanitizeDiagnosticMessage(rawMessage),
        lastCheckedAt: new Date().toISOString(),
      });
    }

    res.json({
      componentName,
      environment: environmentName,
      pullRequest: {
        number: pullRequest.number,
        url: pullRequest.url,
        state: pullRequest.state,
        mergeCommitSha: pullRequest.mergeCommitSha,
        promotedAt: pullRequest.promotedAt,
        isStale: pullRequest.isStale,
      },
      deployment: {
        state: deploymentState,
        bindingReady,
        statusReason: environment?.deployment.statusReason
          ? sanitizeDiagnosticMessage(environment.deployment.statusReason)
          : undefined,
        statusMessage: environment?.deployment.statusMessage
          ? sanitizeDiagnosticMessage(environment.deployment.statusMessage)
          : undefined,
      },
      diagnostics,
      lastCheckedAt: new Date().toISOString(),
    });
  });

  return router;
}
