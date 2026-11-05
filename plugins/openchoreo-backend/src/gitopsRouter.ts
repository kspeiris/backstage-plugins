import { InputError } from '@backstage/errors';
import type {
  HttpAuthService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import type { Request } from 'express';
import type { EnvironmentInfoService } from './services/EnvironmentService/EnvironmentInfoService';
import type { GitOpsChangeTrackerService } from './services/GitOpsChangeTrackerService';
import type {
  GitOpsOverridePreviewService,
  PreviewOverrideRequest,
} from './services/GitOpsOverridePreviewService';
import type {
  GitOpsOverridePullRequestService,
  CreatePullRequestRequest,
} from './services/GitOpsOverridePullRequestService';
import type { GitOpsOverridePRIdempotencyService } from './services/GitOpsOverridePRIdempotencyService';
import type { PatchOptions } from '@openchoreo/backstage-plugin-common';
import express from 'express';
import Router from 'express-promise-router';
import {
  OpenChoreoTokenService,
  createUserTokenMiddleware,
  getUserTokenFromRequest,
  createRequireAuthMiddleware,
} from '@openchoreo/openchoreo-auth';
import type {
  GitOpsStatusDiagnostic,
  GitOpsOwnershipState,
  DeploymentState,
} from '@openchoreo/backstage-plugin-common';
import {
  validateGitOpsOwnershipInput,
  type GitOpsOwnershipInput,
  type GitOpsOwnershipService,
} from './services/GitOpsOwnershipService';
import {
  validateGitOpsTargetInput,
  type GitOpsTargetInput,
  type GitOpsTargetConfigurationService,
} from './services/GitOpsTargetConfigurationService';
import {
  GitOpsAdminAuthorizationService,
  type GitOpsUserPrincipal,
} from './services/GitOpsAdminAuthorizationService';

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

function parsePatchOptions(value: unknown): PatchOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputError('overrides must be an object');
  }

  const allowedFields = [
    'componentTypeEnvironmentConfigs',
    'traitEnvironmentConfigs',
    'workloadOverrides',
  ] as const;
  const overrideValues = value as Record<string, unknown>;
  const parsed: PatchOptions = {};

  for (const [key, section] of Object.entries(overrideValues)) {
    if (!allowedFields.includes(key as (typeof allowedFields)[number])) {
      throw new InputError(`Invalid override field: ${key}`);
    }
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      throw new InputError(`${key} must be an object`);
    }

    switch (key) {
      case 'componentTypeEnvironmentConfigs':
        parsed.componentTypeEnvironmentConfigs = section as Record<
          string,
          unknown
        >;
        break;
      case 'traitEnvironmentConfigs':
        parsed.traitEnvironmentConfigs = section as Record<string, unknown>;
        break;
      case 'workloadOverrides':
        parsed.workloadOverrides = section as Record<string, unknown>;
        break;
      default:
        throw new InputError(`Invalid override field: ${key}`);
    }
  }

  if (Object.keys(parsed).length === 0) {
    throw new InputError('At least one override section must be provided');
  }
  return parsed;
}

function parseOwnershipInput(body: unknown): GitOpsOwnershipInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InputError('Request body must be an object');
  }
  const values = body as Record<string, unknown>;
  const ownershipStates: GitOpsOwnershipState[] = [
    'GITOPS_MANAGED',
    'API_MANAGED',
    'UNKNOWN',
  ];
  if (
    typeof values.ownership !== 'string' ||
    !ownershipStates.includes(values.ownership as GitOpsOwnershipState)
  ) {
    throw new InputError(
      'ownership must be one of: GITOPS_MANAGED, API_MANAGED, UNKNOWN',
    );
  }
  const optionalString = (value: unknown, name: string): string | undefined => {
    if (value === undefined) {
      return undefined;
    }
    return requiredBodyString(value, name);
  };
  const input: GitOpsOwnershipInput = {
    namespaceName: requiredBodyString(values.namespaceName, 'namespaceName'),
    projectName: requiredBodyString(values.projectName, 'projectName'),
    componentName: requiredBodyString(values.componentName, 'componentName'),
    environment: requiredBodyString(values.environment, 'environment'),
    ownership: values.ownership as GitOpsOwnershipState,
    repositoryProvider:
      optionalString(values.repositoryProvider, 'repositoryProvider') ??
      'github',
    repositoryOwner: optionalString(values.repositoryOwner, 'repositoryOwner'),
    repositoryName: optionalString(values.repositoryName, 'repositoryName'),
    baseBranch: optionalString(values.baseBranch, 'baseBranch'),
    manifestPath: optionalString(values.manifestPath, 'manifestPath'),
  };
  if (
    input.repositoryProvider !== undefined &&
    input.repositoryProvider !== 'github'
  ) {
    throw new InputError('repositoryProvider must be github');
  }
  validateGitOpsOwnershipInput(input);
  return input;
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

function parseTargetInput(body: unknown): GitOpsTargetInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InputError('Request body must be an object');
  }
  const values = body as Record<string, unknown>;
  const optionalString = (value: unknown, name: string): string | undefined => {
    if (value === undefined) {
      return undefined;
    }
    return requiredBodyString(value, name);
  };
  const input: GitOpsTargetInput = {
    namespaceName: requiredBodyString(values.namespaceName, 'namespaceName'),
    projectName: requiredBodyString(values.projectName, 'projectName'),
    componentName: requiredBodyString(values.componentName, 'componentName'),
    environment: requiredBodyString(values.environment, 'environment'),
    repositoryProvider:
      optionalString(values.repositoryProvider, 'repositoryProvider') ??
      'github',
    repositoryOwner: requiredBodyString(
      values.repositoryOwner,
      'repositoryOwner',
    ),
    repositoryName: requiredBodyString(values.repositoryName, 'repositoryName'),
    baseBranch: requiredBodyString(values.baseBranch, 'baseBranch'),
    manifestPath: requiredBodyString(values.manifestPath, 'manifestPath'),
  };
  validateGitOpsTargetInput(input);
  return input;
}

export async function createGitOpsRouter({
  trackerService,
  ownershipService,
  targetService,
  overridePreviewService,
  overridePullRequestService,
  idempotencyService,
  httpAuth,
  adminAuthorizationService,
  environmentInfoService,
  tokenService,
  authEnabled,
  logger,
}: {
  trackerService: GitOpsChangeTrackerService;
  ownershipService?: GitOpsOwnershipService;
  targetService?: GitOpsTargetConfigurationService;
  overridePreviewService: GitOpsOverridePreviewService;
  overridePullRequestService?: GitOpsOverridePullRequestService;
  idempotencyService?: GitOpsOverridePRIdempotencyService;
  httpAuth: HttpAuthService;
  adminAuthorizationService: GitOpsAdminAuthorizationService;
  environmentInfoService: EnvironmentInfoService;
  tokenService: OpenChoreoTokenService;
  authEnabled: boolean;
  logger: LoggerService;
}): Promise<express.Router> {
  void idempotencyService;
  const router = Router();
  router.use(express.json());
  router.use(createUserTokenMiddleware(tokenService));
  const requireAuth = createRequireAuthMiddleware(tokenService, authEnabled);
  const getUserPrincipal = async (req: Request): Promise<GitOpsUserPrincipal> =>
    (await httpAuth.credentials(req, { allow: ['user'] })).principal;
  const requireAdmin = async (req: Request): Promise<void> => {
    adminAuthorizationService.assertAdmin(await getUserPrincipal(req));
  };

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

  router.get('/gitops/ownership', async (req, res) => {
    await getUserPrincipal(req);
    const namespaceParam = req.query.namespaceName;
    if (namespaceParam !== undefined && typeof namespaceParam !== 'string') {
      throw new InputError('namespaceName must be a single string');
    }
    const namespaceName =
      typeof namespaceParam === 'string' && namespaceParam.trim()
        ? namespaceParam.trim()
        : 'default';
    const projectName = requiredQueryString(req.query.project, 'project');
    const componentName = requiredQueryString(req.query.component, 'component');
    const environmentName = requiredQueryString(
      req.query.environment,
      'environment',
    );

    if (!ownershipService) {
      throw new InputError('Ownership service is not available');
    }

    const ownership = await ownershipService.getOwnership({
      namespaceName,
      projectName,
      componentName,
      environment: environmentName,
    });

    res.json({
      namespaceName: ownership.namespaceName,
      projectName: ownership.projectName,
      componentName: ownership.componentName,
      environment: ownership.environment,
      ownership: ownership.ownership,
      repositoryConfigured: ownership.repositoryConfigured ?? false,
      repository: ownership.repository,
      repositoryProvider: ownership.repositoryProvider,
      repositoryOwner: ownership.repositoryOwner,
      repositoryName: ownership.repositoryName,
      baseBranch: ownership.baseBranch,
      manifestPath: ownership.manifestPath,
      updatedAt: ownership.updatedAt,
    });
  });

  router.post('/gitops/ownership', requireAuth, async (req, res) => {
    await requireAdmin(req);
    if (!ownershipService) {
      throw new InputError('Ownership service is not available');
    }
    const ownership = await ownershipService.createOwnership(
      parseOwnershipInput(req.body),
    );
    res.status(201).json(ownership);
  });

  router.put('/gitops/ownership', requireAuth, async (req, res) => {
    await requireAdmin(req);
    if (!ownershipService) {
      throw new InputError('Ownership service is not available');
    }
    const ownership = await ownershipService.updateOwnership(
      parseOwnershipInput(req.body),
    );
    res.json(ownership);
  });

  router.delete('/gitops/ownership', requireAuth, async (req, res) => {
    await requireAdmin(req);
    if (!ownershipService) {
      throw new InputError('Ownership service is not available');
    }
    const namespaceName = requiredBodyString(
      req.body?.namespaceName,
      'namespaceName',
    );
    const projectName = requiredBodyString(
      req.body?.projectName,
      'projectName',
    );
    const componentName = requiredBodyString(
      req.body?.componentName,
      'componentName',
    );
    const environment = requiredBodyString(
      req.body?.environment,
      'environment',
    );

    await ownershipService.deleteOwnership({
      namespaceName,
      projectName,
      componentName,
      environment,
    });
    res.status(204).end();
  });

  // GitOps Target Configuration endpoints (independent of ownership classification)
  router.get('/gitops/targets', async (req, res) => {
    await getUserPrincipal(req);
    if (!targetService) {
      throw new InputError('GitOps target service is not configured');
    }
    const namespaceParam = req.query.namespaceName;
    if (namespaceParam !== undefined && typeof namespaceParam !== 'string') {
      throw new InputError('namespaceName must be a single string');
    }
    const namespaceName =
      typeof namespaceParam === 'string' && namespaceParam.trim()
        ? namespaceParam.trim()
        : 'default';
    const projectName = requiredQueryString(req.query.project, 'project');
    const componentName = requiredQueryString(req.query.component, 'component');
    const environmentName = requiredQueryString(
      req.query.environment,
      'environment',
    );

    const target = await targetService.getTarget({
      namespaceName,
      projectName,
      componentName,
      environment: environmentName,
    });

    res.json(target);
  });

  router.post('/gitops/targets', requireAuth, async (req, res) => {
    await requireAdmin(req);
    if (!targetService) {
      throw new InputError('GitOps target service is not configured');
    }
    const target = await targetService.createTarget(
      parseTargetInput(req.body),
    );
    res.status(201).json(target);
  });

  router.put('/gitops/targets', requireAuth, async (req, res) => {
    await requireAdmin(req);
    if (!targetService) {
      throw new InputError('GitOps target service is not configured');
    }
    const target = await targetService.updateTarget(
      parseTargetInput(req.body),
    );
    res.json(target);
  });

  router.delete('/gitops/targets', requireAuth, async (req, res) => {
    await requireAdmin(req);
    if (!targetService) {
      throw new InputError('GitOps target service is not configured');
    }
    const namespaceName = requiredBodyString(
      req.body?.namespaceName,
      'namespaceName',
    );
    const projectName = requiredBodyString(
      req.body?.projectName,
      'projectName',
    );
    const componentName = requiredBodyString(
      req.body?.componentName,
      'componentName',
    );
    const environment = requiredBodyString(
      req.body?.environment,
      'environment',
    );

    await targetService.deleteTarget({
      namespaceName,
      projectName,
      componentName,
      environment,
    });
    res.status(204).end();
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
    let deploymentState: DeploymentState;
    if (
      diagnostics.some(
        diagnostic => diagnostic.reason === 'DeploymentStatusUnavailable',
      )
    ) {
      deploymentState = 'UNKNOWN';
    } else if (!environment?.bindingName) {
      deploymentState =
        pullRequest.state === 'MERGED' ? 'SYNC_PENDING' : 'NOT_STARTED';
    } else if (environment.deployment.status === 'Ready') {
      deploymentState = 'READY';
    } else if (environment.deployment.status === 'Failed') {
      deploymentState = 'FAILED';
    } else if (environment.deployment.status === 'NotReady') {
      deploymentState = 'DEPLOYING';
    } else {
      deploymentState = 'RECONCILING';
    }

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
          environment?.deployment.statusReason,
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

  router.post('/gitops/overrides/preview', requireAuth, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      throw new InputError('Request body must be an object');
    }

    const values = body as Record<string, unknown>;

    const namespaceName = requiredBodyString(
      values.namespace ?? values.namespaceName,
      'namespace',
    );
    const projectName = requiredBodyString(
      values.project ?? values.projectName,
      'project',
    );
    const componentName = requiredBodyString(
      values.component ?? values.componentName,
      'component',
    );
    const environment = requiredBodyString(values.environment, 'environment');

    const previewRequest: PreviewOverrideRequest = {
      namespaceName,
      projectName,
      componentName,
      environment,
      overrides: parsePatchOptions(values.overrides),
    };

    const result = await overridePreviewService.preview(previewRequest);

    if (!result.valid) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  });


  router.post('/gitops/overrides/pull-request', requireAuth, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      throw new InputError('Request body must be an object');
    }

    const values = body as Record<string, unknown>;

    const namespaceName = requiredBodyString(
      values.namespace ?? values.namespaceName,
      'namespace',
    );
    const projectName = requiredBodyString(
      values.project ?? values.projectName,
      'project',
    );
    const componentName = requiredBodyString(
      values.component ?? values.componentName,
      'component',
    );
    const environment = requiredBodyString(values.environment, 'environment');
    const expectedSha = requiredBodyString(values.expectedSha, 'expectedSha');
    const idempotencyKey =
      typeof values.idempotencyKey === 'string' && values.idempotencyKey.trim()
        ? values.idempotencyKey.trim()
        : undefined;

    const overrides = parsePatchOptions({
      componentTypeEnvironmentConfigs: values.componentTypeEnvironmentConfigs,
      traitEnvironmentConfigs: values.traitEnvironmentConfigs,
      workloadOverrides: values.workloadOverrides,
    });

    const request: CreatePullRequestRequest = {
      namespaceName,
      projectName,
      componentName,
      environment,
      expectedSha,
      componentTypeEnvironmentConfigs: overrides.componentTypeEnvironmentConfigs,
      traitEnvironmentConfigs: overrides.traitEnvironmentConfigs,
      workloadOverrides: overrides.workloadOverrides,
      title: typeof values.title === 'string' ? values.title : undefined,
      description:
        typeof values.description === 'string' ? values.description : undefined,
      idempotencyKey,
    };

    try {
      if (!overridePullRequestService) {
        throw new InputError('Pull request service is not configured');
      }
      const result = await overridePullRequestService.createPullRequest(request);
      if (result.changed === false || result.message === 'No changes detected. Nothing needs to be submitted.' || result.error === 'No changes detected') {
        res.status(200).json({
          success: true,
          changed: false,
          message: result.message || 'No changes detected. Nothing needs to be submitted.',
        });
        return;
      }
      res.status(201).json(result);
    } catch (error) {
      if (error instanceof Error && error.name === 'ConflictError') {
        res.status(409).json({
          success: false,
          error: error.message,
        });
        return;
      }
      throw error;
    }
  });

  return router;
}
