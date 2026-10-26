import { createReleaseBindingGenerateAction } from './releaseBindingGenerate';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

jest.setTimeout(30_000);

describe('openchoreo:gitops:releasebinding:generate', () => {
  let workspacePath: string;
  let fakeOccPath: string;
  let previousOccBin: string | undefined;
  let previousHome: string | undefined;
  let action: ReturnType<typeof createReleaseBindingGenerateAction>;

  const validInput = {
    namespace: 'default',
    project: 'sample-project',
    component: 'hello-world',
    targetEnvironment: 'staging',
    releaseName: 'hello-world-v1',
  };

  const expectedManifest = {
    apiVersion: 'openchoreo.dev/v1alpha1',
    kind: 'ReleaseBinding',
    metadata: {
      name: 'hello-world-staging',
      namespace: 'default',
    },
    spec: {
      environment: 'staging',
      owner: {
        componentName: 'hello-world',
        projectName: 'sample-project',
      },
      releaseName: 'hello-world-v1',
    },
  };

  const createComponentDirectory = async () => {
    const componentDirectory = path.join(
      workspacePath,
      'projects',
      validInput.project,
      'components',
      validInput.component,
    );

    await fs.mkdir(componentDirectory, { recursive: true });
    return componentDirectory;
  };

  const runAction = async (
    input: {
      namespace: string;
      project: string;
      component: string;
      targetEnvironment: string;
      releaseName: string;
      generationMode?: 'auto' | 'occ';
    } = validInput,
  ) => {
    const output: Record<string, unknown> = {};

    const ctx = {
      input,
      workspacePath,
      output: (key: string, value: unknown) => {
        output[key] = value;
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      },
    };

    await action.handler(ctx as never);
    return output;
  };

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'release-binding-test-'),
    );

    previousOccBin = process.env.OCC_BIN;
    previousHome = process.env.HOME;

    // Isolate the OCC configuration lookup from the developer machine.
    process.env.HOME = path.join(workspacePath, 'home');
    await fs.mkdir(process.env.HOME, { recursive: true });

    // Fake OCC script: mirrors real OCC's file-writing behavior.
    fakeOccPath = path.join(workspacePath, 'fake-occ.cjs');

    const fakeOccScript = `
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const args = process.argv.slice(2);

  if (args[0] !== 'releasebinding' || args[1] !== 'generate') {
    console.error('Unexpected command: ' + args.join(' '));
    process.exit(2);
  }

  function value(flag) {
    const index = args.indexOf(flag);
    if (index === -1 || !args[index + 1]) {
      throw new Error('Missing flag: ' + flag);
    }
    return args[index + 1];
  }

  const root = value('--root-dir');
  const project = value('--project');
  const component = value('--component');
  const environment = value('--target-env');
  const releaseName = value('--component-release');

  const outputPath = path.join(
    root,
    'projects',
    project,
    'components',
    component,
    'release-bindings',
    component + '-' + environment + '.yaml',
  );

  const lines = [
    'apiVersion: openchoreo.dev/v1alpha1',
    'kind: ReleaseBinding',
    'metadata:',
    '  name: ' + component + '-' + environment,
    '  namespace: default',
    'spec:',
    '  environment: ' + environment,
    '  owner:',
    '    componentName: ' + component,
    '    projectName: ' + project,
    '  releaseName: ' + releaseName,
    '',
  ];

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, lines.join('\\n'), 'utf8');

  console.log('Loading index...');
  console.log('Created: ' + outputPath);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
`;

    await fs.writeFile(fakeOccPath, fakeOccScript, 'utf8');

    // Wrapper shell script so the action can execFile it directly.
    const wrapperPath = path.join(workspacePath, 'fake-occ');

    await fs.writeFile(
      wrapperPath,
      `#!/bin/sh\nexec "${process.execPath}" "${fakeOccPath}" "$@"\n`,
      'utf8',
    );

    await fs.chmod(wrapperPath, 0o755);
    process.env.OCC_BIN = wrapperPath;

    action = createReleaseBindingGenerateAction();
  });

  afterEach(async () => {
    if (previousOccBin === undefined) {
      delete process.env.OCC_BIN;
    } else {
      process.env.OCC_BIN = previousOccBin;
    }

    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('generates a ReleaseBinding through OCC and stages it for the PR', async () => {
    await createComponentDirectory();

    const output = await runAction();

    const relativePath =
      'projects/sample-project/components/hello-world/release-bindings/hello-world-staging.yaml';

    const stagingRelativePath = 'promotion-staging/hello-world-staging.yaml';

    const generated = YAML.parse(
      await fs.readFile(path.join(workspacePath, relativePath), 'utf8'),
    );

    const staged = YAML.parse(
      await fs.readFile(path.join(workspacePath, stagingRelativePath), 'utf8'),
    );

    expect(generated).toEqual(expectedManifest);
    expect(staged).toEqual(expectedManifest);

    expect(output.filePath).toBe(relativePath);
    expect(output.stagingPath).toBe(stagingRelativePath);
    expect(output.operation).toBe('created');
  });

  it('reports "updated" when the binding file already exists before OCC runs', async () => {
    await createComponentDirectory();

    const bindingPath = path.join(
      workspacePath,
      'projects/sample-project/components/hello-world/release-bindings/hello-world-staging.yaml',
    );

    await fs.mkdir(path.dirname(bindingPath), { recursive: true });

    // Write a pre-existing placeholder binding.
    await fs.writeFile(
      bindingPath,
      YAML.stringify({
        apiVersion: 'openchoreo.dev/v1alpha1',
        kind: 'ReleaseBinding',
        metadata: { name: 'hello-world-staging', namespace: 'default' },
        spec: {
          owner: {
            projectName: 'sample-project',
            componentName: 'hello-world',
          },
          environment: 'staging',
          releaseName: 'hello-world-v0',
        },
      }),
      'utf8',
    );

    const output = await runAction();

    expect(output.operation).toBe('updated');
  });

  it('rejects a missing component directory before invoking OCC', async () => {
    await expect(runAction()).rejects.toThrow(
      'Cannot promote component because its directory was not found',
    );

    // Staging directory must not be created.
    await expect(
      fs.access(path.join(workspacePath, 'promotion-staging')),
    ).rejects.toThrow();
  });

  it('rejects a generated manifest with a namespace mismatch', async () => {
    await createComponentDirectory();

    // Fake OCC always writes "default" namespace; passing another triggers the check.
    const input = { ...validInput, namespace: 'another-namespace' };

    await expect(runAction(input)).rejects.toThrow(
      'OCC-generated ReleaseBinding does not match',
    );
  });

  it('surfaces OCC process errors as a descriptive action error', async () => {
    await createComponentDirectory();

    // Replace wrapper with one that always fails.
    const failingWrapper = path.join(workspacePath, 'fail-occ');

    await fs.writeFile(
      failingWrapper,
      '#!/bin/sh\necho "pipeline not found" >&2\nexit 1\n',
      'utf8',
    );

    await fs.chmod(failingWrapper, 0o755);
    process.env.OCC_BIN = failingWrapper;

    // Re-create action so it picks up the new OCC_BIN.
    action = createReleaseBindingGenerateAction();

    await expect(runAction()).rejects.toThrow(
      'OCC failed to generate the ReleaseBinding',
    );
  });

  it('rejects when OCC exits successfully but writes no file', async () => {
    await createComponentDirectory();

    // Wrapper exits 0 without writing anything.
    const noopWrapper = path.join(workspacePath, 'noop-occ');

    await fs.writeFile(
      noopWrapper,
      '#!/bin/sh\necho "Loading index..."\nexit 0\n',
      'utf8',
    );

    await fs.chmod(noopWrapper, 0o755);
    process.env.OCC_BIN = noopWrapper;

    action = createReleaseBindingGenerateAction();

    await expect(runAction()).rejects.toThrow(
      'OCC completed without creating the expected ReleaseBinding',
    );
  });

  it('falls back to the canonical manifest when the repository has no OpenChoreo metadata', async () => {
    await createComponentDirectory();

    const missingMetadataWrapper = path.join(
      workspacePath,
      'missing-metadata-occ',
    );

    await fs.writeFile(
      missingMetadataWrapper,
      '#!/bin/sh\necho "Loading index..."\necho \'Error: project "sample-project" not found in namespace "default"\' >&2\nexit 1\n',
      'utf8',
    );

    await fs.chmod(missingMetadataWrapper, 0o755);
    process.env.OCC_BIN = missingMetadataWrapper;

    action = createReleaseBindingGenerateAction();

    const output = await runAction();

    const relativePath =
      'projects/sample-project/components/hello-world/release-bindings/hello-world-staging.yaml';

    const generated = YAML.parse(
      await fs.readFile(path.join(workspacePath, relativePath), 'utf8'),
    );

    const staged = YAML.parse(
      await fs.readFile(
        path.join(workspacePath, 'promotion-staging/hello-world-staging.yaml'),
        'utf8',
      ),
    );

    expect(generated).toEqual(expectedManifest);
    expect(staged).toEqual(expectedManifest);
    expect(output.generatedBy).toBe('direct');
    expect(output.operation).toBe('created');
  });

  it('fails instead of falling back when generationMode is "occ"', async () => {
    await createComponentDirectory();

    const missingMetadataWrapper = path.join(
      workspacePath,
      'missing-metadata-occ',
    );

    await fs.writeFile(
      missingMetadataWrapper,
      '#!/bin/sh\necho \'Error: project "sample-project" not found in namespace "default"\' >&2\nexit 1\n',
      'utf8',
    );

    await fs.chmod(missingMetadataWrapper, 0o755);
    process.env.OCC_BIN = missingMetadataWrapper;

    action = createReleaseBindingGenerateAction();

    await expect(
      runAction({ ...validInput, generationMode: 'occ' }),
    ).rejects.toThrow('OCC failed to generate the ReleaseBinding');
  });

  it('does not fall back for unrelated OCC failures', async () => {
    await createComponentDirectory();

    const failingWrapper = path.join(workspacePath, 'unrelated-failure-occ');

    await fs.writeFile(
      failingWrapper,
      '#!/bin/sh\necho "unexpected internal failure" >&2\nexit 1\n',
      'utf8',
    );

    await fs.chmod(failingWrapper, 0o755);
    process.env.OCC_BIN = failingWrapper;

    action = createReleaseBindingGenerateAction();

    await expect(runAction()).rejects.toThrow(
      'OCC failed to generate the ReleaseBinding',
    );
  });

  it('updates the release name of an existing binding when OCC cannot run', async () => {
    await createComponentDirectory();

    const bindingPath = path.join(
      workspacePath,
      'projects/sample-project/components/hello-world/release-bindings/hello-world-staging.yaml',
    );

    await fs.mkdir(path.dirname(bindingPath), { recursive: true });

    await fs.writeFile(
      bindingPath,
      YAML.stringify({
        apiVersion: 'openchoreo.dev/v1alpha1',
        kind: 'ReleaseBinding',
        metadata: {
          name: 'hello-world-staging',
          namespace: 'default',
          labels: { 'openchoreo.dev/environment': 'staging' },
        },
        spec: {
          owner: {
            projectName: 'sample-project',
            componentName: 'hello-world',
          },
          environment: 'staging',
          releaseName: 'hello-world-v0',
        },
      }),
      'utf8',
    );

    const missingMetadataWrapper = path.join(
      workspacePath,
      'missing-metadata-occ',
    );

    await fs.writeFile(
      missingMetadataWrapper,
      '#!/bin/sh\necho \'Error: deployment pipeline "default" not found\' >&2\nexit 1\n',
      'utf8',
    );

    await fs.chmod(missingMetadataWrapper, 0o755);
    process.env.OCC_BIN = missingMetadataWrapper;

    action = createReleaseBindingGenerateAction();

    const output = await runAction();

    const generated = YAML.parse(await fs.readFile(bindingPath, 'utf8'));

    expect(generated.metadata.labels).toEqual({
      'openchoreo.dev/environment': 'staging',
    });
    expect(generated.spec.releaseName).toBe('hello-world-v1');
    expect(generated.metadata.name).toBe('hello-world-staging');
    expect(output.operation).toBe('updated');
    expect(output.generatedBy).toBe('direct');
  });

  it('reports an unchanged binding when the generated manifest matches the target branch', async () => {
    await createComponentDirectory();

    const bindingPath = path.join(
      workspacePath,
      'projects/sample-project/components/hello-world/release-bindings/hello-world-staging.yaml',
    );

    await fs.mkdir(path.dirname(bindingPath), { recursive: true });
    await fs.writeFile(bindingPath, YAML.stringify(expectedManifest), 'utf8');

    const output = await runAction();

    expect(output.operation).toBe('updated');
    expect(output.changed).toBe(false);
  });

  it('reports a changed binding when the target branch has no binding yet', async () => {
    await createComponentDirectory();

    const output = await runAction();

    expect(output.operation).toBe('created');
    expect(output.changed).toBe(true);
  });

  it('hands the requested namespace to OCC through an isolated context', async () => {
    await createComponentDirectory();

    const namespaceAwareScript = path.join(workspacePath, 'namespace-occ.cjs');

    await fs.writeFile(
      namespaceAwareScript,
      `
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const args = process.argv.slice(2);

  function value(flag) {
    const index = args.indexOf(flag);
    if (index === -1 || !args[index + 1]) {
      throw new Error('Missing flag: ' + flag);
    }
    return args[index + 1];
  }

  const root = value('--root-dir');
  const project = value('--project');
  const component = value('--component');
  const environment = value('--target-env');
  const releaseName = value('--component-release');

  let namespace = 'default';

  try {
    const config = await fs.readFile(
      path.join(process.env.HOME, '.openchoreo', 'config'),
      'utf8',
    );
    const match = config.match(/namespace:\\s*(\\S+)/);
    if (match) {
      namespace = match[1];
    }
  } catch (error) {
    console.error('no context configuration found: ' + error.message);
  }

  const outputPath = path.join(
    root,
    'projects',
    project,
    'components',
    component,
    'release-bindings',
    component + '-' + environment + '.yaml',
  );

  const lines = [
    'apiVersion: openchoreo.dev/v1alpha1',
    'kind: ReleaseBinding',
    'metadata:',
    '  name: ' + component + '-' + environment,
    '  namespace: ' + namespace,
    'spec:',
    '  environment: ' + environment,
    '  owner:',
    '    componentName: ' + component,
    '    projectName: ' + project,
    '  releaseName: ' + releaseName,
    '',
  ];

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, lines.join('\\n'), 'utf8');

  console.log('Created: ' + outputPath);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
`,
      'utf8',
    );

    const namespaceAwareWrapper = path.join(workspacePath, 'namespace-occ');

    await fs.writeFile(
      namespaceAwareWrapper,
      `#!/bin/sh\nexec "${process.execPath}" "${namespaceAwareScript}" "$@"\n`,
      'utf8',
    );

    await fs.chmod(namespaceAwareWrapper, 0o755);
    process.env.OCC_BIN = namespaceAwareWrapper;

    action = createReleaseBindingGenerateAction();

    const output = await runAction({
      ...validInput,
      namespace: 'another-namespace',
    });

    const generated = YAML.parse(
      await fs.readFile(
        path.join(
          workspacePath,
          'projects/sample-project/components/hello-world/release-bindings/hello-world-staging.yaml',
        ),
        'utf8',
      ),
    );

    expect(generated.metadata.namespace).toBe('another-namespace');
    expect(output.generatedBy).toBe('occ');
  });
});
