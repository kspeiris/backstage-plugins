import { createGitOpsCheckConflictsAction } from './gitopsCheckConflicts';

describe('openchoreo:gitops:check-conflicts', () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.GITHUB_TOKEN;

  const run = async (fetchImpl: typeof fetch) => {
    process.env.GITHUB_TOKEN = 'test-token';
    global.fetch = fetchImpl;
    const output: Record<string, unknown> = {};
    const action = createGitOpsCheckConflictsAction();
    await action.handler({
      input: {
        repository: 'https://github.com/example/gitops',
        targetBranch: 'main',
        targetPath:
          'projects/default/components/hello-world/release-bindings/hello-world-staging.yaml',
        namespace: 'default',
        project: 'sample-project',
        component: 'hello-world',
        targetEnvironment: 'staging',
      },
      output: (key: string, value: unknown) => {
        output[key] = value;
      },
      logger: { info: jest.fn(), warn: jest.fn() },
    } as any);
    return output;
  };

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  });

  it('returns no conflict for an unrelated changed file', async () => {
    const result = await run(
      jest
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([
              {
                number: 12,
                title: 'Update docs',
                html_url: 'https://github.com/example/gitops/pull/12',
                state: 'open',
              },
            ]),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify([{ filename: 'README.md' }]), {
            status: 200,
          }),
        ),
    );

    expect(result.hasConflict).toBe(false);
  });

  it('returns the matching existing pull request', async () => {
    const result = await run(
      jest
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([
              {
                number: 11,
                title: 'Promote hello-world to staging',
                html_url: 'https://github.com/example/gitops/pull/11',
                state: 'open',
                user: { login: 'developer' },
              },
            ]),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([
              {
                filename:
                  'projects/default/components/hello-world/release-bindings/hello-world-staging.yaml',
              },
            ]),
            { status: 200 },
          ),
        ),
    );

    expect(result.hasConflict).toBe(true);
    expect(result.existingPullRequest).toMatchObject({
      number: 11,
      author: 'developer',
    });
  });

  it('fails closed when GitHub cannot list pull requests', async () => {
    await expect(
      run(
        jest
          .fn()
          .mockResolvedValue(new Response('unavailable', { status: 503 })),
      ),
    ).rejects.toThrow(/failed to list pull requests/i);
  });
});
