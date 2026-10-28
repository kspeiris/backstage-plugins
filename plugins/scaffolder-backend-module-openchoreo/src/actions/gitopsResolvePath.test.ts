import { createGitOpsResolvePathAction } from './gitopsResolvePath';

describe('openchoreo:gitops:resolve-path', () => {
  const run = async (input: Record<string, string>) => {
    const output: Record<string, unknown> = {};
    const action = createGitOpsResolvePathAction();
    await action.handler({
      input,
      output: (key: string, value: unknown) => {
        output[key] = value;
      },
      logger: { info: jest.fn() },
    } as any);
    return output;
  };

  it('returns the deterministic ReleaseBinding path', async () => {
    await expect(
      run({
        namespace: 'default',
        project: 'sample-project',
        component: 'hello-world',
        targetEnvironment: 'staging',
      }),
    ).resolves.toEqual({
      targetPath:
        'projects/sample-project/components/hello-world/release-bindings/hello-world-staging.yaml',
    });
  });

  it('rejects traversal and invalid resource names', async () => {
    await expect(
      run({
        namespace: 'default',
        project: '../outside',
        component: 'hello-world',
        targetEnvironment: 'staging',
      }),
    ).rejects.toThrow(/invalid/i);
  });
});
