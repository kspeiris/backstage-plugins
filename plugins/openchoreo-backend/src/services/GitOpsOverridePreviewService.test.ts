import { NotFoundError, ServiceUnavailableError } from '@backstage/errors';
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { GithubCredentialsProvider } from '@backstage/integration';
import type { GitOpsTargetConfig } from '@openchoreo/backstage-plugin-common';
import type { GitOpsTargetConfigurationService } from './GitOpsTargetConfigurationService';
import { GitOpsOverridePreviewService } from './GitOpsOverridePreviewService';

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
  fetchResponse,
}: {
  target?: GitOpsTargetConfig | null;
  fetchResponse?: Response;
} = {}) {
  const findTarget = jest.fn().mockResolvedValue(target);
  const targetService = {
    findTarget,
  } as unknown as GitOpsTargetConfigurationService;
  const credentialsProvider = {
    getCredentials: jest.fn().mockResolvedValue({ headers: {} }),
  } as unknown as GithubCredentialsProvider;
  const githubFetchMock = jest.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      fetchResponse ??
      new Response(
        JSON.stringify({
          content: Buffer.from(originalManifest).toString('base64'),
          encoding: 'base64',
          sha,
        }),
        { status: 200 },
      ),
  );
  const logger = {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  } as unknown as LoggerService;

  return {
    service: new GitOpsOverridePreviewService(
      logger,
      targetService,
      credentialsProvider,
      githubFetchMock as typeof fetch,
    ),
    githubFetch: githubFetchMock,
    findTarget,
  };
}

const request = {
  namespaceName: 'default',
  projectName: 'default',
  componentName: 'biocare-web',
  environment: 'staging',
  overrides: { workloadOverrides: { replicas: 4 } },
};

describe('GitOpsOverridePreviewService', () => {
  it('fetches the configured manifest using targetService, patches it, and returns unified diff and original SHA without ownership classification', async () => {
    const { service, githubFetch, findTarget } = createService();

    const result = await service.preview(request);

    expect(findTarget).toHaveBeenCalledWith({
      namespaceName: 'default',
      projectName: 'default',
      componentName: 'biocare-web',
      environment: 'staging',
    });
    expect(result).toMatchObject({
      valid: true,
      repository: 'openchoreo/gitops',
      baseBranch: 'main',
      originalSha: sha,
      changed: true,
    });
    expect((result as any).ownership).toBeUndefined();
    expect(result.originalManifest).toBe(originalManifest);
    expect(result.proposedManifest).toContain('replicas: 4');
    expect(result.proposedManifest).toContain('releaseName: release-v1');
    expect(result.diff).toContain('--- a/projects/default/components/');
    expect(result.diff).toContain('-    replicas: 1');
    expect(result.diff).toContain('+    replicas: 4');
    expect(githubFetch).toHaveBeenCalledTimes(1);
    expect(githubFetch.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
  });

  it('works regardless of legacy ownership classification, provided a valid target exists', async () => {
    // Target configuration exists for the resource regardless of what legacy ownership table might have
    const { service, githubFetch } = createService({
      target: targetConfig,
    });

    const result = await service.preview(request);

    expect(result.valid).toBe(true);
    expect(result.repository).toBe('openchoreo/gitops');
    expect(githubFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects missing target configuration without contacting GitHub and returns clear administrator message', async () => {
    const { service, githubFetch } = createService({
      target: null,
    });

    const result = await service.preview(request);

    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      'GitOps target is not configured. Please contact your platform administrator.',
    );
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it('returns an invalid preview when the fetched manifest contains invalid YAML', async () => {
    const { service } = createService({
      fetchResponse: new Response(
        JSON.stringify({
          content: Buffer.from('not: valid: yaml:').toString('base64'),
          encoding: 'base64',
          sha,
        }),
        { status: 200 },
      ),
    });

    const result = await service.preview(request);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid ReleaseBinding YAML');
  });

  it('returns an invalid preview when manifest identity does not match the target configuration', async () => {
    const mismatchedManifest = originalManifest.replace(
      'namespace: default',
      'namespace: other',
    );
    const { service } = createService({
      fetchResponse: new Response(
        JSON.stringify({
          content: Buffer.from(mismatchedManifest).toString('base64'),
          encoding: 'base64',
          sha,
        }),
        { status: 200 },
      ),
    });

    const result = await service.preview(request);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('identity does not match');
  });

  it('reports a missing manifest distinctly', async () => {
    const { service } = createService({
      fetchResponse: new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
      }),
    });

    await expect(service.preview(request)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('reports GitHub access failures explicitly', async () => {
    const { service } = createService({
      fetchResponse: new Response('Forbidden', { status: 403 }),
    });

    await expect(service.preview(request)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });

  it('uses the authoritative configured path and performs no repository writes (read-only)', async () => {
    const { service, githubFetch } = createService();

    await service.preview(request);

    expect(String(githubFetch.mock.calls[0][0])).toContain(
      '/contents/projects/default/components/biocare-web/release-bindings/biocare-web-staging.yaml?ref=main',
    );
    expect(githubFetch.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
    expect(githubFetch).toHaveBeenCalledTimes(1);
  });
});
