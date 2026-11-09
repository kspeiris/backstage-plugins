import crypto from 'crypto';
import { ConflictError, InputError, NotFoundError } from '@backstage/errors';
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { GithubCredentialsProvider } from '@backstage/integration';
import type { GitOpsTargetConfig } from '@openchoreo/backstage-plugin-common';
import type { GitOpsTargetConfigurationService } from './GitOpsTargetConfigurationService';
import {
  createGitOpsOverridePullRequestService,
  GitOpsOverridePullRequestService,
} from './GitOpsOverridePullRequestService';
import type {
  GitOpsOverridePRIdempotencyService,
  IdempotencyRecord,
} from './GitOpsOverridePRIdempotencyService';

const originalManifest = `apiVersion: openchoreo.dev/v1alpha1
kind: ReleaseBinding
metadata:
  name: biocare-web-staging
  namespace: default
spec:
  owner:
    projectName: default
    componentName: biocare-web
  environment: staging
  releaseName: release-v1
  workloadOverrides:
    replicas: 1
`;

const targetConfig: GitOpsTargetConfig = {
  namespaceName: 'default',
  projectName: 'default',
  componentName: 'biocare-web',
  environment: 'staging',
  repositoryProvider: 'github',
  repositoryOwner: 'openchoreo',
  repositoryName: 'gitops',
  repository: 'openchoreo/gitops',
  baseBranch: 'main',
  manifestPath:
    'projects/default/components/biocare-web/release-bindings/biocare-web-staging.yaml',
};

const sha = '0123456789abcdef0123456789abcdef01234567';

function createService({
  target = targetConfig,
  idempotencyService,
  manifestContent = originalManifest,
}: {
  target?: GitOpsTargetConfig | null;
  idempotencyService?: GitOpsOverridePRIdempotencyService;
  manifestContent?: string;
} = {}) {
  const findTarget = jest.fn().mockResolvedValue(target);
  const targetService = {
    findTarget,
  } as unknown as GitOpsTargetConfigurationService;
  const credentialsProvider = {
    getCredentials: jest
      .fn()
      .mockResolvedValue({ headers: { Authorization: 'Bearer token' } }),
  } as unknown as GithubCredentialsProvider;

  const githubFetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/contents/')) {
      if (init?.method === 'PUT') {
        return new Response(JSON.stringify({ content: { sha: 'newsha' } }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          content: Buffer.from(manifestContent).toString('base64'),
          encoding: 'base64',
          sha,
        }),
        { status: 200 },
      );
    }
    if (url.includes('/git/ref/heads/')) {
      return new Response(
        JSON.stringify({
          object: { sha: 'base1234567890abcdef1234567890abcdef123456' },
        }),
        { status: 200 },
      );
    }
    if (url.includes('/git/refs') && init?.method === 'POST') {
      return new Response(JSON.stringify({}), { status: 201 });
    }
    if (url.includes('/pulls') && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          number: 42,
          html_url: 'https://github.com/openchoreo/gitops/pull/42',
          title: 'chore(gitops): update biocare-web overrides in staging',
          head: { ref: 'gitops/overrides/biocare-web-staging-abc123' },
          base: { ref: 'main' },
        }),
        { status: 201 },
      );
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  const logger = {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  } as unknown as LoggerService;

  return {
    service: new GitOpsOverridePullRequestService(
      logger,
      targetService,
      credentialsProvider,
      githubFetch,
      idempotencyService,
    ),
    githubFetch,
    findTarget,
    targetService,
    logger,
    credentialsProvider,
  };
}

describe('GitOpsOverridePullRequestService', () => {
  const duplicateRequestHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        namespaceName: 'default',
        projectName: 'default',
        componentName: 'biocare-web',
        environment: 'staging',
        expectedSha: sha,
        workloadOverrides: { replicas: 4 },
      }),
    )
    .digest('hex');

  it('creates a pull request successfully with optimistic concurrency control', async () => {
    const { service } = createService();

    const result = await service.createPullRequest({
      namespaceName: 'default',
      projectName: 'default',
      componentName: 'biocare-web',
      environment: 'staging',
      expectedSha: sha,
      workloadOverrides: { replicas: 4 },
    });

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.pullRequest?.number).toBe(42);
    expect(result.pullRequest?.url).toBe(
      'https://github.com/openchoreo/gitops/pull/42',
    );
  });

  it('returns the first result for a duplicate idempotency key without creating another PR', async () => {
    let record: IdempotencyRecord | null = null;
    const idempotencyService = {
      get: jest.fn(async () => record),
      createInProgress: jest.fn(async (next: IdempotencyRecord) => {
        if (record) return false;
        record = next;
        return true;
      }),
      updateCompleted: jest.fn(
        async (key: string, updates: Partial<IdempotencyRecord>) => {
          if (record?.key === key) {
            record = { ...record, ...updates, status: 'COMPLETED' };
          }
        },
      ),
    } as unknown as GitOpsOverridePRIdempotencyService;
    const {
      targetService,
      githubFetch,
      logger,
      findTarget,
      credentialsProvider,
    } = createService();
    const service = createGitOpsOverridePullRequestService({
      logger,
      targetService,
      githubCredentialsProvider: credentialsProvider,
      githubFetch,
      idempotencyService,
    });
    const request = {
      namespaceName: 'default',
      projectName: 'default',
      componentName: 'biocare-web',
      environment: 'staging',
      expectedSha: sha,
      workloadOverrides: { replicas: 4 },
      idempotencyKey: 'same-request',
    };

    const firstResult = await service.createPullRequest(request);
    const secondResult = await service.createPullRequest(request);

    expect(secondResult).toEqual(firstResult);
    expect(firstResult.pullRequest?.number).toBe(42);
    expect(findTarget).toHaveBeenCalledTimes(1);
    expect(idempotencyService.createInProgress).toHaveBeenCalledTimes(1);
    expect(idempotencyService.updateCompleted).toHaveBeenCalledTimes(1);
  });

  it('rejects a second concurrent request while the first idempotency key is in progress', async () => {
    const inProgressRecord: IdempotencyRecord = {
      key: 'same-request',
      namespaceName: 'default',
      projectName: 'default',
      componentName: 'biocare-web',
      environment: 'staging',
      requestHash: duplicateRequestHash,
      status: 'IN_PROGRESS',
    };
    const idempotencyService = {
      get: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(inProgressRecord),
      createInProgress: jest.fn().mockResolvedValue(false),
      updateCompleted: jest.fn(),
    } as unknown as GitOpsOverridePRIdempotencyService;
    const { service, findTarget } = createService({ idempotencyService });

    await expect(
      service.createPullRequest({
        namespaceName: 'default',
        projectName: 'default',
        componentName: 'biocare-web',
        environment: 'staging',
        expectedSha: sha,
        workloadOverrides: { replicas: 4 },
        idempotencyKey: 'same-request',
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(idempotencyService.createInProgress).toHaveBeenCalledTimes(1);
    expect(findTarget).not.toHaveBeenCalled();
  });

  it('marks a reserved idempotency key failed when request processing fails', async () => {
    const idempotencyService = {
      get: jest.fn().mockResolvedValue(null),
      createInProgress: jest.fn().mockResolvedValue(true),
      updateCompleted: jest.fn(),
      updateFailed: jest.fn(),
    } as unknown as GitOpsOverridePRIdempotencyService;
    const { service } = createService({
      target: null,
      idempotencyService,
    });

    await expect(
      service.createPullRequest({
        namespaceName: 'default',
        projectName: 'default',
        componentName: 'biocare-web',
        environment: 'staging',
        expectedSha: sha,
        workloadOverrides: { replicas: 4 },
        idempotencyKey: 'failed-request',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(idempotencyService.updateFailed).toHaveBeenCalledWith(
      'failed-request',
      'GitOps target is not configured. Please contact your platform administrator.',
    );
  });

  it('rejects with 409 when SHA mismatch occurs', async () => {
    const { service } = createService();

    await expect(
      service.createPullRequest({
        namespaceName: 'default',
        projectName: 'default',
        componentName: 'biocare-web',
        environment: 'staging',
        expectedSha: '1111111111111111111111111111111111111111',
        workloadOverrides: { replicas: 4 },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('throws NotFoundError when target is missing', async () => {
    const { service } = createService({ target: null });

    await expect(
      service.createPullRequest({
        namespaceName: 'default',
        projectName: 'default',
        componentName: 'biocare-web',
        environment: 'staging',
        expectedSha: sha,
        workloadOverrides: { replicas: 4 },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns no changes when patch produces no diff', async () => {
    const { service } = createService();

    const result = await service.createPullRequest({
      namespaceName: 'default',
      projectName: 'default',
      componentName: 'biocare-web',
      environment: 'staging',
      expectedSha: sha,
      workloadOverrides: { replicas: 1 },
    });

    expect(result.success).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.message).toBe(
      'No changes detected. Nothing needs to be submitted.',
    );
  });

  it('rejects invalid YAML from patcher with InputError context', async () => {
    const { service } = createService({
      manifestContent: 'apiVersion: [invalid',
    });

    await expect(
      service.createPullRequest({
        namespaceName: 'default',
        projectName: 'default',
        componentName: 'biocare-web',
        environment: 'staging',
        expectedSha: sha,
        workloadOverrides: { replicas: 4 },
      }),
    ).rejects.toBeInstanceOf(InputError);
  });
});
