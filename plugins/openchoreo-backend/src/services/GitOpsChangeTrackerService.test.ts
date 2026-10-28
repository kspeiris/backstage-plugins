import { mockServices, TestDatabases } from '@backstage/backend-test-utils';
import type { DatabaseService } from '@backstage/backend-plugin-api';
import {
  applyGitOpsChangeTrackerMigrations,
  GitOpsChangeTrackerService,
} from './GitOpsChangeTrackerService';

const databases = TestDatabases.create({ ids: ['SQLITE_3'] });
const logger = mockServices.logger.mock();

describe('GitOpsChangeTrackerService', () => {
  let knex: Awaited<ReturnType<DatabaseService['getClient']>>;

  beforeEach(async () => {
    knex = await databases.init('SQLITE_3');
    await applyGitOpsChangeTrackerMigrations(knex, logger);
  });

  afterEach(async () => {
    await knex.destroy();
  });

  it('persists promotion records and refreshes pull request state', async () => {
    const fetchGitHub = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          state: 'closed',
          merged_at: '2026-10-27T00:00:00Z',
          merge_commit_sha: 'abc123',
        }),
        { status: 200 },
      ),
    );
    const githubCredentialsProvider = {
      getCredentials: jest.fn().mockResolvedValue({
        headers: { Authorization: 'token test-token' },
      }),
    };
    const input = {
      namespaceName: 'default',
      projectName: 'biocare',
      componentName: 'biocare-web',
      environment: 'staging',
      repositoryOwner: 'openchoreo',
      repositoryName: 'gitops',
      pullRequestNumber: 42,
    };

    await new GitOpsChangeTrackerService(
      knex,
      logger,
      githubCredentialsProvider,
      fetchGitHub,
    ).recordPromotion(input);

    const restartedService = new GitOpsChangeTrackerService(
      knex,
      logger,
      githubCredentialsProvider,
      fetchGitHub,
    );
    const status = await restartedService.getPullRequestStatus({
      namespaceName: input.namespaceName,
      projectName: input.projectName,
      componentName: input.componentName,
      environment: input.environment,
    });

    expect(status).toEqual(
      expect.objectContaining({
        number: 42,
        url: 'https://github.com/openchoreo/gitops/pull/42',
        state: 'MERGED',
        mergeCommitSha: 'abc123',
        promotedAt: expect.any(String),
      }),
    );
    expect(status.lastCheckedAt).toEqual(expect.any(String));
    expect(fetchGitHub).toHaveBeenCalledWith(
      'https://api.github.com/repos/openchoreo/gitops/pulls/42',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'token test-token',
        }),
      }),
    );
    expect(githubCredentialsProvider.getCredentials).toHaveBeenCalledWith({
      url: 'https://github.com/openchoreo/gitops',
    });
    expect(status.isStale).toBe(false);
  });

  it('returns NOT_CREATED when there is no promotion record', async () => {
    const service = new GitOpsChangeTrackerService(knex, logger);

    await expect(
      service.getPullRequestStatus({
        namespaceName: 'default',
        projectName: 'biocare',
        componentName: 'biocare-web',
        environment: 'staging',
      }),
    ).resolves.toEqual({ state: 'NOT_CREATED' });
  });

  it('returns the last known state with an explicit stale indicator on GitHub failures', async () => {
    const loggerWithWarn = {
      ...logger,
      warn: jest.fn(),
    };
    const githubCredentialsProvider = {
      getCredentials: jest.fn().mockResolvedValue({
        headers: { Authorization: 'token test-token' },
      }),
    };
    const input = {
      namespaceName: 'default',
      projectName: 'biocare',
      componentName: 'biocare-web',
      environment: 'staging',
      repositoryOwner: 'openchoreo',
      repositoryName: 'gitops',
      pullRequestNumber: 42,
    };
    const availableService = new GitOpsChangeTrackerService(
      knex,
      loggerWithWarn,
      githubCredentialsProvider,
      jest.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            state: 'closed',
            merged_at: '2026-10-27T00:00:00Z',
            merge_commit_sha: 'last-known-sha',
          }),
          { status: 200 },
        ),
      ),
    );
    await availableService.recordPromotion(input);
    const lookup = {
      namespaceName: input.namespaceName,
      projectName: input.projectName,
      componentName: input.componentName,
      environment: input.environment,
    };
    const freshStatus = await availableService.getPullRequestStatus(lookup);
    const unavailableService = new GitOpsChangeTrackerService(
      knex,
      loggerWithWarn,
      githubCredentialsProvider,
      jest.fn().mockResolvedValue(new Response('unavailable', { status: 503 })),
    );

    await expect(
      unavailableService.getPullRequestStatus(lookup),
    ).resolves.toEqual(
      expect.objectContaining({
        number: 42,
        state: 'MERGED',
        mergeCommitSha: 'last-known-sha',
        lastCheckedAt: freshStatus.lastCheckedAt,
        isStale: true,
      }),
    );
    expect(loggerWithWarn.warn).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 503'),
    );
    expect(loggerWithWarn.warn.mock.calls.flat().join(' ')).not.toContain(
      'test-token',
    );
  });

  it.each([
    ['open', null, 'OPEN'],
    ['closed', null, 'CLOSED'],
    ['closed', '2026-10-27T00:00:00Z', 'MERGED'],
  ] as const)(
    'maps GitHub state %s with merged_at %s to %s',
    async (githubState, mergedAt, expectedState) => {
      const service = new GitOpsChangeTrackerService(
        knex,
        logger,
        { getCredentials: jest.fn().mockResolvedValue({}) },
        jest.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              state: githubState,
              merged_at: mergedAt,
              merge_commit_sha: expectedState === 'MERGED' ? 'merge-sha' : null,
            }),
            { status: 200 },
          ),
        ),
      );
      await service.recordPromotion({
        namespaceName: 'default',
        projectName: 'biocare',
        componentName: 'biocare-web',
        environment: 'staging',
        repositoryOwner: 'openchoreo',
        repositoryName: 'gitops',
        pullRequestNumber: 42,
      });

      await expect(
        service.getPullRequestStatus({
          namespaceName: 'default',
          projectName: 'biocare',
          componentName: 'biocare-web',
          environment: 'staging',
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          state: expectedState,
          mergeCommitSha: expectedState === 'MERGED' ? 'merge-sha' : undefined,
          isStale: false,
        }),
      );
    },
  );

  it('returns the last known state as stale if integration credentials cannot be resolved', async () => {
    const service = new GitOpsChangeTrackerService(knex, logger, {
      getCredentials: jest
        .fn()
        .mockRejectedValue(new Error('credential error')),
    });
    await service.recordPromotion({
      namespaceName: 'default',
      projectName: 'biocare',
      componentName: 'biocare-web',
      environment: 'staging',
      repositoryOwner: 'openchoreo',
      repositoryName: 'gitops',
      pullRequestNumber: 42,
    });

    await expect(
      service.getPullRequestStatus({
        namespaceName: 'default',
        projectName: 'biocare',
        componentName: 'biocare-web',
        environment: 'staging',
      }),
    ).resolves.toEqual(
      expect.objectContaining({ state: 'OPEN', isStale: true }),
    );
  });
});
