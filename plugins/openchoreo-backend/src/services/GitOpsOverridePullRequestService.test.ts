import { ConflictError, NotFoundError } from '@backstage/errors';
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { GithubCredentialsProvider } from '@backstage/integration';
import type { GitOpsTargetConfig } from '@openchoreo/backstage-plugin-common';
import type { GitOpsTargetConfigurationService } from './GitOpsTargetConfigurationService';
import { GitOpsOverridePullRequestService } from './GitOpsOverridePullRequestService';

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
}: {
  target?: GitOpsTargetConfig | null;
} = {}) {
  const findTarget = jest.fn().mockResolvedValue(target);
  const targetService = {
    findTarget,
  } as unknown as GitOpsTargetConfigurationService;
  const credentialsProvider = {
    getCredentials: jest.fn().mockResolvedValue({ headers: { Authorization: 'Bearer token' } }),
  } as unknown as GithubCredentialsProvider;

  const githubFetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/contents/')) {
      if (init?.method === 'PUT') {
        return new Response(JSON.stringify({ content: { sha: 'newsha' } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          content: Buffer.from(originalManifest).toString('base64'),
          encoding: 'base64',
          sha,
        }),
        { status: 200 },
      );
    }
    if (url.includes('/git/ref/heads/')) {
      return new Response(
        JSON.stringify({ object: { sha: 'base1234567890abcdef1234567890abcdef123456' } }),
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
    ),
    githubFetch,
    findTarget,
  };
}

describe('GitOpsOverridePullRequestService', () => {
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
    expect(result.pullRequest?.url).toBe('https://github.com/openchoreo/gitops/pull/42');
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
    expect(result.message).toBe('No changes detected. Nothing needs to be submitted.');
  });

  it('rejects invalid YAML from patcher with InputError context', async () => {
    const { service } = createService();
    const bad = {
      ...require('fs'),
    };
  });
});
