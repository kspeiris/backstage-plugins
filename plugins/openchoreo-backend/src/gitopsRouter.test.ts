import { mockErrorHandler } from '@backstage/backend-test-utils';
import express from 'express';
import request from 'supertest';
import type { OpenChoreoTokenService } from '@openchoreo/openchoreo-auth';
import type { EnvironmentInfoService } from './services/EnvironmentService/EnvironmentInfoService';
import type { GitOpsChangeTrackerService } from './services/GitOpsChangeTrackerService';
import type { FluxStatusService } from './services/FluxStatusService';
import type { GitOpsOwnershipService } from './services/GitOpsOwnershipService';
import type { GitOpsOverridePreviewService } from './services/GitOpsOverridePreviewService';
import type { GitOpsTargetConfigurationService } from './services/GitOpsTargetConfigurationService';
import { createGitOpsRouter } from './gitopsRouter';
import { GitOpsAdminAuthorizationService } from './services/GitOpsAdminAuthorizationService';

jest.mock('@openchoreo/openchoreo-auth', () => ({
  createUserTokenMiddleware: jest.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
  ),
  getUserTokenFromRequest: jest.fn().mockReturnValue('mock-user-token'),
  createRequireAuthMiddleware: jest.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
  ),
}));

describe('GitOps status API', () => {
  let userPrincipal: {
    userEntityRef: string;
    ownershipEntityRefs: string[];
  };
  const trackerService = {
    recordPromotion: jest.fn(),
    getPullRequestStatus: jest.fn(),
  } as unknown as GitOpsChangeTrackerService;
  const ownershipService = {
    getOwnership: jest.fn(),
    createOwnership: jest.fn(),
    updateOwnership: jest.fn(),
    deleteOwnership: jest.fn(),
  } as unknown as GitOpsOwnershipService;
  const targetService = {
    getTarget: jest.fn(),
    createTarget: jest.fn(),
    updateTarget: jest.fn(),
    deleteTarget: jest.fn(),
  } as unknown as GitOpsTargetConfigurationService;
  const environmentInfoService = {
    fetchDeploymentInfo: jest.fn(),
  } as unknown as EnvironmentInfoService;
  const overridePreviewService = {
    preview: jest.fn(),
  } as unknown as GitOpsOverridePreviewService;

  async function createApp(fluxStatusService?: FluxStatusService) {
    const router = await createGitOpsRouter({
      trackerService,
      ownershipService,
      targetService,
      overridePreviewService,
      httpAuth: {
        credentials: jest.fn().mockImplementation(async () => ({
          principal: userPrincipal,
        })),
      } as never,
      adminAuthorizationService: new GitOpsAdminAuthorizationService(
        ['user:default/admin@example.com'],
        ['group:default/platform-admins'],
      ),
      environmentInfoService,
      fluxStatusService,
      tokenService: {} as OpenChoreoTokenService,
      authEnabled: true,
      logger: {
        error: jest.fn(),
      } as never,
    });
    const app = express();
    app.use(router);
    app.use(mockErrorHandler());
    return app;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    userPrincipal = {
      userEntityRef: 'user:default/developer@example.com',
      ownershipEntityRefs: ['user:default/developer@example.com'],
    };
  });

  it('returns PR and live deployment states for a component environment', async () => {
    trackerService.getPullRequestStatus = jest.fn().mockResolvedValue({
      number: 17,
      url: 'https://github.com/openchoreo/gitops/pull/17',
      state: 'MERGED',
      mergeCommitSha: 'abc123',
      promotedAt: '2026-10-26T00:00:00Z',
      lastCheckedAt: '2026-10-27T00:00:00Z',
      isStale: false,
    });

    environmentInfoService.fetchDeploymentInfo = jest.fn().mockResolvedValue([
      {
        name: 'staging',
        resourceName: 'staging',
        bindingName: 'biocare-web-staging',
        deployment: {
          status: 'Ready',
          statusReason: 'RolloutComplete',
          statusMessage: 'All replicas are ready.',
        },
      },
    ]);

    const response = await request(await createApp())
      .get('/gitops/status')
      .query({
        project: 'biocare',
        component: 'biocare-web',
        environment: 'staging',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      componentName: 'biocare-web',
      environment: 'staging',
      pullRequest: {
        number: 17,
        url: 'https://github.com/openchoreo/gitops/pull/17',
        state: 'MERGED',
        mergeCommitSha: 'abc123',
        promotedAt: '2026-10-26T00:00:00Z',
        isStale: false,
      },
      deployment: {
        state: 'READY',
        bindingReady: true,
        statusReason: 'RolloutComplete',
        statusMessage: 'All replicas are ready.',
      },
      diagnostics: [],
      lastCheckedAt: expect.any(String),
    });
    expect(environmentInfoService.fetchDeploymentInfo).toHaveBeenCalledWith(
      {
        namespaceName: 'default',
        projectName: 'biocare',
        componentName: 'biocare-web',
      },
      'mock-user-token',
    );
  });

  it('returns Flux source and applied revisions with reconciliation state', async () => {
    trackerService.getPullRequestStatus = jest.fn().mockResolvedValue({
      state: 'MERGED',
      number: 17,
    });
    environmentInfoService.fetchDeploymentInfo = jest.fn().mockResolvedValue([
      {
        name: 'staging',
        resourceName: 'staging',
        bindingName: 'biocare-web-staging',
        deployment: { status: 'Ready' },
      },
    ]);

    const getStatus = jest.fn().mockResolvedValue({
      state: 'SYNCED',
      sourceRevision: 'main@sha1:abc123',
      appliedRevision: 'main@sha1:abc123',
    });
    const response = await request(
      await createApp({ getStatus } as unknown as FluxStatusService),
    )
      .get('/gitops/status')
      .query({
        project: 'biocare',
        component: 'biocare-web',
        environment: 'staging',
      });

    expect(response.status).toBe(200);
    expect(response.body.flux).toEqual({
      state: 'SYNCED',
      sourceRevision: 'main@sha1:abc123',
      appliedRevision: 'main@sha1:abc123',
    });
    expect(getStatus).toHaveBeenCalledWith({
      namespaceName: 'default',
      projectName: 'biocare',
      componentName: 'biocare-web',
    });
  });

  it('returns an explicit Flux diagnostic when reconciliation status is unavailable', async () => {
    trackerService.getPullRequestStatus = jest.fn().mockResolvedValue({
      state: 'MERGED',
    });
    environmentInfoService.fetchDeploymentInfo = jest
      .fn()
      .mockResolvedValue([]);

    const response = await request(
      await createApp({
        getStatus: jest
          .fn()
          .mockRejectedValue(new Error('token=do-not-return')),
      } as unknown as FluxStatusService),
    )
      .get('/gitops/status')
      .query({
        project: 'biocare',
        component: 'biocare-web',
        environment: 'staging',
      });

    expect(response.status).toBe(200);
    expect(response.body.flux).toEqual({ state: 'UNKNOWN' });
    expect(response.body.diagnostics).toContainEqual(
      expect.objectContaining({
        source: 'Flux CD',
        reason: 'FluxStatusUnavailable',
        message:
          'The backend could not retrieve Flux reconciliation status. Refresh to try again.',
      }),
    );
    expect(JSON.stringify(response.body)).not.toContain('do-not-return');
  });

  it('returns structured deployment failure diagnostics and redacts credentials', async () => {
    trackerService.getPullRequestStatus = jest.fn().mockResolvedValue({
      state: 'MERGED',
      number: 17,
      url: 'https://github.com/openchoreo/gitops/pull/17',
    });
    environmentInfoService.fetchDeploymentInfo = jest.fn().mockResolvedValue([
      {
        name: 'staging',
        resourceName: 'staging',
        bindingName: 'biocare-web-staging',
        deployment: {
          status: 'Failed',
          statusReason: 'FluxReconciliationFailed',
          statusMessage:
            'Flux CD failed using token=private-value and Authorization: Bearer private-auth',
        },
      },
    ]);

    const response = await request(await createApp())
      .get('/gitops/status')
      .query({
        project: 'biocare',
        component: 'biocare-web',
        environment: 'staging',
      });

    expect(response.status).toBe(200);
    expect(response.body.deployment.state).toBe('FAILED');
    expect(response.body.diagnostics).toEqual([
      expect.objectContaining({
        source: 'Flux CD',
        reason: 'FluxReconciliationFailed',
        message:
          'Flux CD failed using token=[REDACTED] and Authorization=[REDACTED]',
        lastCheckedAt: expect.any(String),
      }),
    ]);
    expect(JSON.stringify(response.body)).not.toContain('private-value');
    expect(JSON.stringify(response.body)).not.toContain('private-auth');
  });

  it('identifies ReleaseBinding failures as OpenChoreo diagnostics', async () => {
    trackerService.getPullRequestStatus = jest.fn().mockResolvedValue({
      state: 'NOT_CREATED',
    });
    environmentInfoService.fetchDeploymentInfo = jest.fn().mockResolvedValue([
      {
        name: 'staging',
        resourceName: 'staging',
        bindingName: 'biocare-web-staging',
        deployment: {
          status: 'Failed',
          statusReason: 'RenderingFailed',
          statusMessage: 'The component configuration could not be rendered.',
        },
      },
    ]);

    const response = await request(await createApp())
      .get('/gitops/status')
      .query({
        project: 'biocare',
        component: 'biocare-web',
        environment: 'staging',
      });

    expect(response.body.diagnostics).toEqual([
      expect.objectContaining({
        source: 'OpenChoreo',
        reason: 'RenderingFailed',
        message: 'The component configuration could not be rendered.',
      }),
    ]);
  });

  it('returns a safe Backstage diagnostic if deployment status cannot be fetched', async () => {
    trackerService.getPullRequestStatus = jest.fn().mockResolvedValue({
      state: 'UNKNOWN',
    });
    environmentInfoService.fetchDeploymentInfo = jest
      .fn()
      .mockRejectedValue(new Error('internal response includes secret'));

    const response = await request(await createApp())
      .get('/gitops/status')
      .query({
        project: 'biocare',
        component: 'biocare-web',
        environment: 'staging',
      });

    expect(response.status).toBe(200);
    expect(response.body.deployment.state).toBe('UNKNOWN');
    expect(response.body.diagnostics).toEqual([
      expect.objectContaining({
        source: 'Backstage backend',
        reason: 'DeploymentStatusUnavailable',
        message:
          'The backend could not retrieve deployment status. Refresh to try again.',
      }),
    ]);
    expect(JSON.stringify(response.body)).not.toContain('internal response');
  });

  it('returns a safe Backstage diagnostic if the PR tracker fails', async () => {
    trackerService.getPullRequestStatus = jest
      .fn()
      .mockRejectedValue(new Error('tracker failed with token=private-value'));
    environmentInfoService.fetchDeploymentInfo = jest.fn().mockResolvedValue([
      {
        name: 'staging',
        resourceName: 'staging',
        bindingName: 'biocare-web-staging',
        deployment: { status: 'Ready' },
      },
    ]);

    const response = await request(await createApp())
      .get('/gitops/status')
      .query({
        project: 'biocare',
        component: 'biocare-web',
        environment: 'staging',
      });

    expect(response.status).toBe(200);
    expect(response.body.pullRequest.state).toBe('UNKNOWN');
    expect(response.body.diagnostics).toEqual([
      expect.objectContaining({
        source: 'Backstage backend',
        reason: 'GitHubStatusUnavailable',
        message:
          'The backend could not retrieve pull request status. Refresh to try again.',
      }),
    ]);
    expect(JSON.stringify(response.body)).not.toContain('private-value');
  });

  it('returns a GitHub diagnostic for stale pull request status', async () => {
    trackerService.getPullRequestStatus = jest.fn().mockResolvedValue({
      state: 'OPEN',
      number: 17,
      url: 'https://github.com/openchoreo/gitops/pull/17',
      isStale: true,
      lastCheckedAt: '2026-10-26T00:00:00Z',
    });
    environmentInfoService.fetchDeploymentInfo = jest
      .fn()
      .mockResolvedValue([]);

    const response = await request(await createApp())
      .get('/gitops/status')
      .query({
        project: 'biocare',
        component: 'biocare-web',
        environment: 'staging',
      });

    expect(response.body.diagnostics).toEqual([
      expect.objectContaining({
        source: 'GitHub',
        reason: 'PullRequestStatusStale',
        lastCheckedAt: '2026-10-26T00:00:00Z',
      }),
    ]);
  });

  it('returns GitOps ownership metadata for a resource', async () => {
    ownershipService.getOwnership = jest.fn().mockResolvedValue({
      namespaceName: 'default',
      projectName: 'biocare',
      componentName: 'biocare-web',
      environment: 'staging',
      ownership: 'GITOPS_MANAGED',
      repositoryProvider: 'github',
      repositoryOwner: 'kspeiris',
      repositoryName: 'openchoreo-gitops_test',
      repository: 'kspeiris/openchoreo-gitops_test',
      baseBranch: 'main',
      manifestPath:
        'projects/default/components/biocare-web/release-bindings/biocare-web-staging.yaml',
      repositoryConfigured: true,
      updatedAt: '2026-10-28T04:30:00.000Z',
    });

    const response = await request(await createApp())
      .get('/gitops/ownership')
      .query({
        project: 'biocare',
        component: 'biocare-web',
        environment: 'staging',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ownership: 'GITOPS_MANAGED',
      repositoryConfigured: true,
      repository: 'kspeiris/openchoreo-gitops_test',
      baseBranch: 'main',
      manifestPath:
        'projects/default/components/biocare-web/release-bindings/biocare-web-staging.yaml',
    });
    expect(ownershipService.getOwnership).toHaveBeenCalledWith({
      namespaceName: 'default',
      projectName: 'biocare',
      componentName: 'biocare-web',
      environment: 'staging',
    });
  });

  it('accepts the documented preview request and returns the preview response', async () => {
    overridePreviewService.preview = jest.fn().mockResolvedValue({
      valid: true,
      repository: 'openchoreo/gitops',
      repositoryOwner: 'openchoreo',
      repositoryName: 'gitops',
      baseBranch: 'main',
      manifestPath:
        'projects/default/components/web/release-bindings/web-staging.yaml',
      originalSha: '0123456789abcdef0123456789abcdef01234567',
      originalManifest: 'original',
      proposedManifest: 'proposed',
      diff: '--- original\n+++ proposed',
      changed: true,
    });

    const response = await request(await createApp())
      .post('/gitops/overrides/preview')
      .send({
        namespace: 'default',
        project: 'default',
        component: 'web',
        environment: 'staging',
        overrides: { workloadOverrides: { replicas: 4 } },
      });

    expect(response.status).toBe(200);
    expect(response.body.originalSha).toBe(
      '0123456789abcdef0123456789abcdef01234567',
    );
    expect(overridePreviewService.preview).toHaveBeenCalledWith({
      namespaceName: 'default',
      projectName: 'default',
      componentName: 'web',
      environment: 'staging',
      overrides: { workloadOverrides: { replicas: 4 } },
    });
  });

  it('rejects unknown override sections before calling the preview service', async () => {
    const response = await request(await createApp())
      .post('/gitops/overrides/preview')
      .send({
        namespace: 'default',
        project: 'default',
        component: 'web',
        environment: 'staging',
        overrides: { repositoryPath: 'untrusted/path.yaml' },
      });

    expect(response.status).toBe(400);
    expect(overridePreviewService.preview).not.toHaveBeenCalled();
  });

  it('allows only configured admins to create ownership mappings', async () => {
    ownershipService.createOwnership = jest.fn().mockResolvedValue({
      namespaceName: 'default',
      projectName: 'biocare',
      componentName: 'biocare-web',
      environment: 'staging',
      ownership: 'API_MANAGED',
      repositoryConfigured: false,
      updatedAt: '2026-10-28T04:30:00.000Z',
    });

    const body = {
      namespaceName: 'default',
      projectName: 'biocare',
      componentName: 'biocare-web',
      environment: 'staging',
      ownership: 'API_MANAGED',
    };
    const deniedResponse = await request(await createApp())
      .post('/gitops/ownership')
      .send(body);

    expect(deniedResponse.status).toBe(403);
    expect(ownershipService.createOwnership).not.toHaveBeenCalled();

    userPrincipal = {
      userEntityRef: 'user:default/admin@example.com',
      ownershipEntityRefs: ['user:default/admin@example.com'],
    };
    const response = await request(await createApp())
      .post('/gitops/ownership')
      .send(body);

    expect(response.status).toBe(201);
    expect(ownershipService.createOwnership).toHaveBeenCalledWith({
      namespaceName: 'default',
      projectName: 'biocare',
      componentName: 'biocare-web',
      environment: 'staging',
      ownership: 'API_MANAGED',
      repositoryProvider: 'github',
      repositoryOwner: undefined,
      repositoryName: undefined,
      baseBranch: undefined,
      manifestPath: undefined,
    });
  });

  it('authorizes configured admin groups and restricts PUT and DELETE to admins', async () => {
    const mapping = {
      namespaceName: 'default',
      projectName: 'biocare',
      componentName: 'biocare-web',
      environment: 'staging',
      ownership: 'API_MANAGED',
    };
    const deniedUpdateResponse = await request(await createApp())
      .put('/gitops/ownership')
      .send(mapping);
    const deniedDeleteResponse = await request(await createApp())
      .delete('/gitops/ownership')
      .send(mapping);

    expect(deniedUpdateResponse.status).toBe(403);
    expect(deniedDeleteResponse.status).toBe(403);
    expect(ownershipService.updateOwnership).not.toHaveBeenCalled();
    expect(ownershipService.deleteOwnership).not.toHaveBeenCalled();

    userPrincipal = {
      userEntityRef: 'user:default/developer@example.com',
      ownershipEntityRefs: [
        'user:default/developer@example.com',
        'group:default/platform-admins',
      ],
    };
    ownershipService.updateOwnership = jest.fn().mockResolvedValue({
      namespaceName: 'default',
      projectName: 'biocare',
      componentName: 'biocare-web',
      environment: 'staging',
      ownership: 'API_MANAGED',
    });
    ownershipService.deleteOwnership = jest.fn().mockResolvedValue(undefined);

    const updateResponse = await request(await createApp())
      .put('/gitops/ownership')
      .send(mapping);
    const deleteResponse = await request(await createApp())
      .delete('/gitops/ownership')
      .send(mapping);

    expect(updateResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(204);
    expect(ownershipService.updateOwnership).toHaveBeenCalled();
    expect(ownershipService.deleteOwnership).toHaveBeenCalledWith({
      namespaceName: mapping.namespaceName,
      projectName: mapping.projectName,
      componentName: mapping.componentName,
      environment: mapping.environment,
    });
  });

  it('keeps UNKNOWN ownership for unmapped resources', async () => {
    ownershipService.getOwnership = jest
      .fn()
      .mockImplementation(async input => ({
        ...input,
        ownership: 'UNKNOWN',
        repositoryConfigured: false,
      }));

    const response = await request(await createApp())
      .get('/gitops/ownership')
      .query({
        project: 'unmapped-project',
        component: 'unmapped-component',
        environment: 'dev',
      });

    expect(response.status).toBe(200);
    expect(response.body.ownership).toBe('UNKNOWN');
  });

  it('validates required status query parameters', async () => {
    const response = await request(await createApp()).get('/gitops/status');

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain(
      'project is required query parameter',
    );
  });

  it('validates and stores promotion PR records', async () => {
    const response = await request(await createApp())
      .post('/gitops/promotions')
      .send({
        namespaceName: 'default',
        projectName: 'biocare',
        componentName: 'biocare-web',
        environment: 'staging',
        repositoryUrl: 'https://github.com/openchoreo/gitops',
        pullRequestUrl: 'https://github.com/openchoreo/gitops/pull/17',
      });

    expect(response.status).toBe(201);
    expect(trackerService.recordPromotion).toHaveBeenCalledWith({
      namespaceName: 'default',
      projectName: 'biocare',
      componentName: 'biocare-web',
      environment: 'staging',
      repositoryOwner: 'openchoreo',
      repositoryName: 'gitops',
      pullRequestNumber: 17,
    });
  });

  it('rejects a pull request URL from another repository', async () => {
    const response = await request(await createApp())
      .post('/gitops/promotions')
      .send({
        namespaceName: 'default',
        projectName: 'biocare',
        componentName: 'biocare-web',
        environment: 'staging',
        repositoryUrl: 'https://github.com/openchoreo/gitops',
        pullRequestUrl: 'https://github.com/someone/else/pull/17',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain(
      'pullRequestUrl must identify a pull request in repositoryUrl',
    );
    expect(trackerService.recordPromotion).not.toHaveBeenCalled();
  });

  describe('GitOps targets API', () => {
    const mockTarget = {
      namespaceName: 'default',
      projectName: 'payments',
      componentName: 'checkout',
      environment: 'staging',
      repositoryProvider: 'github',
      repositoryOwner: 'acme',
      repositoryName: 'gitops-repo',
      repository: 'acme/gitops-repo',
      baseBranch: 'main',
      manifestPath: 'manifests/checkout-staging.yaml',
    };

    it('returns target configuration for a resource', async () => {
      userPrincipal = {
        userEntityRef: 'user:default/developer',
        ownershipEntityRefs: [],
      };
      (targetService.getTarget as jest.Mock).mockResolvedValueOnce(mockTarget);

      const response = await request(await createApp())
        .get('/gitops/targets')
        .query({
          project: 'payments',
          component: 'checkout',
          environment: 'staging',
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockTarget);
      expect(targetService.getTarget).toHaveBeenCalledWith({
        namespaceName: 'default',
        projectName: 'payments',
        componentName: 'checkout',
        environment: 'staging',
      });
    });

    it('allows only configured admins to create target configurations', async () => {
      userPrincipal = {
        userEntityRef: 'user:default/regular-dev',
        ownershipEntityRefs: [],
      };

      const response = await request(await createApp())
        .post('/gitops/targets')
        .send(mockTarget);

      expect(response.status).toBe(403);
      expect(targetService.createTarget).not.toHaveBeenCalled();

      userPrincipal = {
        userEntityRef: 'user:default/admin@example.com',
        ownershipEntityRefs: [],
      };
      (targetService.createTarget as jest.Mock).mockResolvedValueOnce(
        mockTarget,
      );

      const adminResponse = await request(await createApp())
        .post('/gitops/targets')
        .send(mockTarget);

      expect(adminResponse.status).toBe(201);
      expect(adminResponse.body).toEqual(mockTarget);
    });

    it('authorizes configured admin groups for PUT and DELETE /gitops/targets', async () => {
      userPrincipal = {
        userEntityRef: 'user:default/team-lead',
        ownershipEntityRefs: ['group:default/platform-admins'],
      };
      (targetService.updateTarget as jest.Mock).mockResolvedValueOnce(
        mockTarget,
      );

      const putResponse = await request(await createApp())
        .put('/gitops/targets')
        .send(mockTarget);

      expect(putResponse.status).toBe(200);

      const deleteResponse = await request(await createApp())
        .delete('/gitops/targets')
        .send({
          namespaceName: 'default',
          projectName: 'payments',
          componentName: 'checkout',
          environment: 'staging',
        });

      expect(deleteResponse.status).toBe(204);
      expect(targetService.deleteTarget).toHaveBeenCalledWith({
        namespaceName: 'default',
        projectName: 'payments',
        componentName: 'checkout',
        environment: 'staging',
      });
    });
  });
});
