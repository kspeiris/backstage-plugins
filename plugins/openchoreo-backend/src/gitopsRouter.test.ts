import { mockErrorHandler } from '@backstage/backend-test-utils';
import express from 'express';
import request from 'supertest';
import type { OpenChoreoTokenService } from '@openchoreo/openchoreo-auth';
import type { EnvironmentInfoService } from './services/EnvironmentService/EnvironmentInfoService';
import type { GitOpsChangeTrackerService } from './services/GitOpsChangeTrackerService';
import { createGitOpsRouter } from './gitopsRouter';

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
  const trackerService = {
    recordPromotion: jest.fn(),
    getPullRequestStatus: jest.fn(),
  } as unknown as GitOpsChangeTrackerService;
  const environmentInfoService = {
    fetchDeploymentInfo: jest.fn(),
  } as unknown as EnvironmentInfoService;

  async function createApp() {
    const router = await createGitOpsRouter({
      trackerService,
      environmentInfoService,
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
});
