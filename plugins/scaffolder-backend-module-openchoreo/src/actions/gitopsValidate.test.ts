import { createGitOpsValidateAction } from './gitopsValidate';

describe('createGitOpsValidateAction', () => {
  const createContext = (input: Record<string, string>) => ({
    input,
    output: jest.fn(),
    logger: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  });

  it('returns validated promotion details', async () => {
    const action = createGitOpsValidateAction();

    const ctx = createContext({
      namespace: 'development',
      project: 'sample-project',
      component: 'hello-world',
      targetEnvironment: 'development',
    });

    await action.handler(ctx as any);

    expect(ctx.output).toHaveBeenCalledWith(
      'namespace',
      'development',
    );

    expect(ctx.output).toHaveBeenCalledWith(
      'project',
      'sample-project',
    );

    expect(ctx.output).toHaveBeenCalledWith(
      'component',
      'hello-world',
    );

    expect(ctx.output).toHaveBeenCalledWith(
      'targetEnvironment',
      'development',
    );

    expect(ctx.output).toHaveBeenCalledWith(
      'validationStatus',
      'valid',
    );
  });

  it('trims whitespace from inputs', async () => {
    const action = createGitOpsValidateAction();

    const ctx = createContext({
      namespace: ' development ',
      project: ' sample-project ',
      component: ' hello-world ',
      targetEnvironment: ' staging ',
    });

    await action.handler(ctx as any);

    expect(ctx.output).toHaveBeenCalledWith(
      'namespace',
      'development',
    );

    expect(ctx.output).toHaveBeenCalledWith(
      'project',
      'sample-project',
    );

    expect(ctx.output).toHaveBeenCalledWith(
      'component',
      'hello-world',
    );

    expect(ctx.output).toHaveBeenCalledWith(
      'targetEnvironment',
      'staging',
    );
  });

  it('rejects empty values', async () => {
    const action = createGitOpsValidateAction();

    const ctx = createContext({
      namespace: '',
      project: 'sample-project',
      component: 'hello-world',
      targetEnvironment: 'development',
    });

    await expect(
      action.handler(ctx as any),
    ).rejects.toThrow(/namespace must not be empty/i);
  });
});
