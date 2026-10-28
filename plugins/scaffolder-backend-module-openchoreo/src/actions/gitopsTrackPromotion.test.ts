import type {
  AuthService,
  DiscoveryService,
} from '@backstage/backend-plugin-api';
import { createGitOpsTrackPromotionAction } from './gitopsTrackPromotion';

describe('openchoreo:gitops:track-promotion', () => {
  const originalFetch = global.fetch;
  const auth = {
    getOwnServiceCredentials: jest.fn().mockResolvedValue({
      $$type: '@backstage/BackstageCredentials',
      principal: { type: 'service', subject: 'plugin:scaffolder' },
    }),
    getPluginRequestToken: jest.fn().mockResolvedValue({
      token: 'openchoreo-service-token',
    }),
  } as unknown as AuthService;
  const discovery = {
    getBaseUrl: jest.fn().mockResolvedValue('http://backstage/api/openchoreo'),
  } as unknown as DiscoveryService;

  const run = async (
    fetchImpl: typeof fetch,
    overrides: Record<string, unknown> = {},
  ) => {
    global.fetch = fetchImpl;
    const output: Record<string, unknown> = {};
    const action = createGitOpsTrackPromotionAction({ auth, discovery });
    await action.handler({
      input: {
        namespace: 'default',
        project: 'shop',
        component: 'web',
        targetEnvironment: 'staging',
        repositoryUrl: 'https://github.com/acme/gitops',
        pullRequestUrl: 'https://github.com/acme/gitops/pull/42',
        ...overrides,
      },
      secrets: { OPENCHOREO_USER_TOKEN: 'user-token' },
      output: (key: string, value: unknown) => {
        output[key] = value;
      },
      logger: { info: jest.fn() },
    } as any);
    return output;
  };

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('records the PR URL and number using internal and user credentials', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(new Response(null, { status: 201 }));
    const result = await run(fetchMock);

    expect(result).toEqual({
      pullRequestNumber: 42,
      pullRequestUrl: 'https://github.com/acme/gitops/pull/42',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backstage/api/openchoreo/gitops/promotions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer openchoreo-service-token',
          'Content-Type': 'application/json',
          'x-openchoreo-token': 'user-token',
        },
      }),
    );
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      namespaceName: 'default',
      projectName: 'shop',
      componentName: 'web',
      environment: 'staging',
      repositoryUrl: 'https://github.com/acme/gitops',
      pullRequestUrl: 'https://github.com/acme/gitops/pull/42',
    });
  });

  it('rejects a pull request URL from a different repository', async () => {
    await expect(
      run(jest.fn(), {
        pullRequestUrl: 'https://github.com/other/repo/pull/42',
      }),
    ).rejects.toThrow('does not match the selected GitHub repository');
  });

  it('surfaces tracker API failures without logging credentials', async () => {
    await expect(
      run(jest.fn().mockResolvedValue(new Response(null, { status: 503 }))),
    ).rejects.toThrow('Failed to record GitOps pull request (HTTP 503)');
  });
});
