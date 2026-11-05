import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { createGitOpsPatchBindingAction } from './gitopsPatchBinding';

describe('openchoreo:gitops:patch-binding', () => {
  let workspacePath: string;
  const action = createGitOpsPatchBindingAction();

  const input = {
    namespace: 'default',
    project: 'sample-project',
    component: 'hello-world',
    targetEnvironment: 'staging',
  };
  const manifestPath =
    'projects/sample-project/components/hello-world/release-bindings/hello-world-staging.yaml';
  const bindingPath = () => path.join(workspacePath, manifestPath);
  const originalManifest = {
    apiVersion: 'openchoreo.dev/v1alpha1',
    kind: 'ReleaseBinding',
    metadata: {
      name: 'hello-world-staging',
      namespace: 'default',
      labels: { keep: 'this' },
    },
    spec: {
      owner: {
        projectName: 'sample-project',
        componentName: 'hello-world',
      },
      environment: 'staging',
      releaseName: 'hello-world-68898ff579',
      workloadOverrides: {
        replicas: 2,
        resources: { requests: { memory: '256Mi', cpu: '100m' } },
      },
      existingUnknownField: { keep: true },
    },
    existingTopLevelField: 'keep-this-too',
  };

  const writeManifest = async (manifest = originalManifest) => {
    await fs.mkdir(path.dirname(bindingPath()), { recursive: true });
    await fs.writeFile(bindingPath(), YAML.stringify(manifest), 'utf8');
  };

  const runAction = async (
    overrides: Record<string, unknown> = {
      workloadOverrides: {
        replicas: 4,
        resources: { requests: { memory: '512Mi' } },
      },
    },
  ) => {
    const output: Record<string, unknown> = {};
    await action.handler({
      input: { ...input, ...overrides },
      workspacePath,
      output: (key: string, value: unknown) => {
        output[key] = value;
      },
      logger: { info: jest.fn(), warn: jest.fn() },
    } as never);
    return output;
  };

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gitops-patch-binding-test-'),
    );
    await writeManifest();
  });

  afterEach(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('loads the existing ReleaseBinding and patches only requested override fields', async () => {
    const output = await runAction();
    const patched = YAML.parse(await fs.readFile(bindingPath(), 'utf8'));

    expect(patched.spec.workloadOverrides).toEqual({
      replicas: 4,
      resources: { requests: { memory: '512Mi', cpu: '100m' } },
    });
    expect(patched.spec.releaseName).toBe('hello-world-68898ff579');
    expect(patched.spec.existingUnknownField).toEqual({ keep: true });
    expect(patched.existingTopLevelField).toBe('keep-this-too');
    expect(patched.metadata.labels).toEqual({ keep: 'this' });
    expect(output).toEqual({
      filePath: manifestPath,
      stagingPath: 'promotion-staging/hello-world-staging.yaml',
      changed: true,
    });
  });

  it('rejects invalid YAML', async () => {
    await fs.writeFile(bindingPath(), 'spec: [not valid', 'utf8');

    await expect(runAction()).rejects.toThrow(/invalid releasebinding yaml/i);
  });

  it.each([
    ['component', { metadata: { name: 'other-staging' } }],
    ['environment', { spec: { environment: 'production' } }],
  ])('rejects a manifest with the wrong %s', async (_label, patch) => {
    const metadataPatch = 'metadata' in patch ? patch.metadata : {};
    const specPatch = 'spec' in patch ? patch.spec : {};
    await writeManifest({
      ...originalManifest,
      ...patch,
      metadata: { ...originalManifest.metadata, ...metadataPatch },
      spec: { ...originalManifest.spec, ...specPatch },
    });

    await expect(runAction()).rejects.toThrow(/identity does not match/i);
  });

  it('reports a clear error when the manifest is missing', async () => {
    await fs.rm(bindingPath());

    await expect(runAction()).rejects.toThrow(
      `ReleaseBinding manifest not found: ${manifestPath}`,
    );
  });

  it('produces the same manifest when the same patch is applied repeatedly', async () => {
    await runAction();
    const afterFirstPatch = await fs.readFile(bindingPath(), 'utf8');

    const secondOutput = await runAction();
    const afterSecondPatch = await fs.readFile(bindingPath(), 'utf8');

    expect(afterSecondPatch).toBe(afterFirstPatch);
    expect(secondOutput.changed).toBe(false);
  });

  it('rejects a request without any override sections', async () => {
    await expect(runAction({})).rejects.toThrow(
      'At least one override section must be provided',
    );
  });
});
