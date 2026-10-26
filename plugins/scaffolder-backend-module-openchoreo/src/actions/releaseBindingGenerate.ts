import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

const execFileAsync = promisify(execFile);

const dnsNamePattern = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const environmentPattern = /^[a-zA-Z0-9]([-a-zA-Z0-9]*[a-zA-Z0-9])?$/;

const releaseBindingApiVersion = 'openchoreo.dev/v1alpha1';
const releaseBindingKind = 'ReleaseBinding';

const occConfigDirectory = '.openchoreo';
const occConfigFileName = 'config';

const missingRepositoryMetadataPatterns: RegExp[] = [
  /project "[^"]*" not found in namespace "[^"]*"/,
  /project "[^"]*" has no deploymentPipelineRef set/,
  /deployment pipeline "[^"]*" not found/,
  /component release "[^"]*" not found or does not belong to component/,
  /no releases found for component/,
];

type ReleaseBinding = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    [key: string]: unknown;
  };
  spec: {
    owner: {
      projectName: string;
      componentName: string;
      [key: string]: unknown;
    };
    environment: string;
    releaseName: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type OccContext = {
  name?: string;
  namespace?: string;
  [key: string]: unknown;
};

type OccConfig = {
  currentContext?: string;
  controlplanes?: unknown[];
  contexts?: OccContext[];
};

type OccEnvironment = {
  env?: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
};

type OccGenerateResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  message: string;
};

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

const readProcessOutput = (
  error: unknown,
  key: 'stdout' | 'stderr',
): string => {
  if (error && typeof error === 'object' && key in error) {
    const value = (error as Record<string, unknown>)[key];

    if (typeof value === 'string') {
      return value;
    }
  }

  return '';
};

const buildReleaseBinding = (
  namespace: string,
  project: string,
  component: string,
  environment: string,
  releaseName: string,
): ReleaseBinding => ({
  apiVersion: releaseBindingApiVersion,
  kind: releaseBindingKind,
  metadata: {
    name: `${component}-${environment}`,
    namespace,
  },
  spec: {
    owner: {
      projectName: project,
      componentName: component,
    },
    environment,
    releaseName,
  },
});

const mergeReleaseBinding = (
  existing: ReleaseBinding,
  canonical: ReleaseBinding,
): ReleaseBinding => ({
  ...existing,
  apiVersion: canonical.apiVersion,
  kind: canonical.kind,
  metadata: {
    ...existing.metadata,
    ...canonical.metadata,
  },
  spec: {
    ...existing.spec,
    ...canonical.spec,
    owner: {
      ...existing.spec?.owner,
      ...canonical.spec.owner,
    },
  },
});

const isSameReleaseBinding = (
  existing: ReleaseBinding,
  generated: ReleaseBinding,
): boolean => {
  const canonicalize = (value: unknown): string =>
    JSON.stringify(value, (_key, entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return entry;
      }

      const sorted: Record<string, unknown> = {};

      for (const key of Object.keys(entry as Record<string, unknown>).sort()) {
        sorted[key] = (entry as Record<string, unknown>)[key];
      }

      return sorted;
    });

  return canonicalize(existing) === canonicalize(generated);
};

const readReleaseBindingFile = async (
  absolutePath: string,
): Promise<ReleaseBinding | undefined> => {
  let contents: string;

  try {
    contents = await fs.readFile(absolutePath, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }

  const parsed = YAML.parse(contents);

  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }

  return parsed as ReleaseBinding;
};

const writeReleaseBindingFile = async (
  absolutePath: string,
  manifest: ReleaseBinding,
): Promise<void> => {
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, YAML.stringify(manifest), 'utf8');
};

const readOccConfig = async (home: string): Promise<OccConfig | undefined> => {
  try {
    const contents = await fs.readFile(
      path.join(home, occConfigDirectory, occConfigFileName),
      'utf8',
    );

    const parsed = YAML.parse(contents);

    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }

    return parsed as OccConfig;
  } catch {
    return undefined;
  }
};

const findCurrentContext = (config: OccConfig | undefined): OccContext => {
  const contexts = Array.isArray(config?.contexts) ? config.contexts : [];
  const currentContext =
    typeof config?.currentContext === 'string' && config.currentContext
      ? config.currentContext
      : undefined;

  const matched = currentContext
    ? contexts.find(context => context?.name === currentContext)
    : undefined;

  return matched ?? { name: currentContext ?? 'default' };
};

const prepareOccEnvironment = async (
  namespace: string,
): Promise<OccEnvironment> => {
  const home = process.env.HOME;

  if (!home) {
    return { cleanup: async () => {} };
  }

  const storedConfig = await readOccConfig(home);
  const currentContext = findCurrentContext(storedConfig);

  if (currentContext.namespace === namespace) {
    return { cleanup: async () => {} };
  }

  // OCC resolves the project from the namespace of the active context, so the
  // requested namespace is handed over through an isolated configuration.
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'occ-home-'));
  const configDirectory = path.join(temporaryHome, occConfigDirectory);

  await fs.mkdir(configDirectory, { recursive: true });

  const isolatedConfig: OccConfig = {
    currentContext: currentContext.name ?? 'default',
    contexts: [
      {
        ...currentContext,
        name: currentContext.name ?? 'default',
        namespace,
      },
    ],
  };

  if (Array.isArray(storedConfig?.controlplanes)) {
    isolatedConfig.controlplanes = storedConfig.controlplanes;
  }

  await fs.writeFile(
    path.join(configDirectory, occConfigFileName),
    YAML.stringify(isolatedConfig),
    'utf8',
  );

  return {
    env: { ...process.env, HOME: temporaryHome },
    cleanup: async () => {
      await fs.rm(temporaryHome, { recursive: true, force: true });
    },
  };
};

const runOccReleaseBindingGenerate = async (
  occBin: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<OccGenerateResult> => {
  try {
    const { stdout, stderr } = await execFileAsync(occBin, args, {
      cwd,
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      ...(env ? { env } : {}),
    });

    return { ok: true, stdout, stderr, message: '' };
  } catch (error) {
    return {
      ok: false,
      stdout: readProcessOutput(error, 'stdout'),
      stderr: readProcessOutput(error, 'stderr'),
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

const isMissingRepositoryMetadata = (result: OccGenerateResult): boolean => {
  const output = `${result.stdout}\n${result.stderr}\n${result.message}`;

  return missingRepositoryMetadataPatterns.some(pattern =>
    pattern.test(output),
  );
};

const locateGeneratedBinding = async (
  absolutePath: string,
  stdout: string,
): Promise<string | undefined> => {
  try {
    await fs.access(absolutePath);
    return absolutePath;
  } catch {
    // OCC resolves the output directory from the indexed resources, so the
    // binding can be written outside of the canonical location.
  }

  const reported = stdout.match(/^(?:Created|Updated):\s*(.+)$/m);

  if (!reported) {
    return undefined;
  }

  const reportedPath = reported[1].trim();

  if (!reportedPath) {
    return undefined;
  }

  try {
    await fs.access(reportedPath);
  } catch {
    return undefined;
  }

  return reportedPath;
};

export const createReleaseBindingGenerateAction = () =>
  createTemplateAction({
    id: 'openchoreo:gitops:releasebinding:generate',
    description: 'Generate an OpenChoreo ReleaseBinding using the OCC CLI',
    schema: {
      input: {
        namespace: z => z.string().min(1).regex(dnsNamePattern),
        project: z => z.string().min(1).regex(dnsNamePattern),
        component: z => z.string().min(1).regex(dnsNamePattern),
        targetEnvironment: z => z.string().min(1).regex(environmentPattern),
        releaseName: z => z.string().min(1).regex(dnsNamePattern),
        generationMode: z => z.enum(['auto', 'occ']).optional(),
      },
      output: {
        filePath: z => z.string(),
        stagingPath: z => z.string(),
        operation: z => z.enum(['created', 'updated']),
        generatedBy: z => z.enum(['occ', 'direct']),
        changed: z => z.boolean(),
      },
    },

    async handler(ctx) {
      const namespace = ctx.input.namespace.trim();
      const project = ctx.input.project.trim();
      const component = ctx.input.component.trim();
      const environment = ctx.input.targetEnvironment.trim();
      const releaseName = ctx.input.releaseName.trim();
      const generationMode = ctx.input.generationMode ?? 'auto';

      for (const [name, value] of Object.entries({
        namespace,
        project,
        component,
        environment,
        releaseName,
      })) {
        if (!value) {
          throw new Error(`${name} must not be empty`);
        }
      }

      if (
        !dnsNamePattern.test(namespace) ||
        !dnsNamePattern.test(project) ||
        !dnsNamePattern.test(component) ||
        !dnsNamePattern.test(releaseName) ||
        !environmentPattern.test(environment)
      ) {
        throw new Error('One or more ReleaseBinding inputs are invalid');
      }

      const workspaceRoot = path.resolve(ctx.workspacePath);

      const relativePath = path.posix.join(
        'projects',
        project,
        'components',
        component,
        'release-bindings',
        `${component}-${environment}.yaml`,
      );

      const absolutePath = path.resolve(workspaceRoot, relativePath);

      if (!absolutePath.startsWith(`${workspaceRoot}${path.sep}`)) {
        throw new Error('Generated path escapes the workspace');
      }

      const componentDirectory = path.resolve(
        workspaceRoot,
        'projects',
        project,
        'components',
        component,
      );

      if (!componentDirectory.startsWith(`${workspaceRoot}${path.sep}`)) {
        throw new Error('Invalid component directory path');
      }

      try {
        const stat = await fs.stat(componentDirectory);

        if (!stat.isDirectory()) {
          throw new Error(
            `Expected component path to be a directory: projects/${project}/components/${component}`,
          );
        }
      } catch (error) {
        const errorCode =
          error && typeof error === 'object' && 'code' in error
            ? (error as NodeJS.ErrnoException).code
            : undefined;

        if (errorCode === 'ENOENT') {
          throw new Error(
            `Cannot promote component because its directory was not found in the fetched GitOps repository: projects/${project}/components/${component}`,
          );
        }

        throw error;
      }

      // Capture whether the binding existed before OCC was invoked.
      let operation: 'created' | 'updated' = 'created';
      let existingBinding: ReleaseBinding | undefined;

      try {
        existingBinding = await readReleaseBindingFile(absolutePath);

        if (existingBinding) {
          operation = 'updated';
        }
      } catch (error) {
        ctx.logger.warn(
          `The existing ReleaseBinding at ${relativePath} could not be parsed and is treated as absent: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      // OCC writes the ReleaseBinding to the standard release-bindings path.
      const occBin = process.env.OCC_BIN || 'occ';

      const args = [
        'releasebinding',
        'generate',
        '--mode',
        'file-system',
        '--root-dir',
        workspaceRoot,
        '--project',
        project,
        '--component',
        component,
        '--target-env',
        environment,
        '--component-release',
        releaseName,
      ];

      const occEnvironment = await prepareOccEnvironment(namespace);

      let manifest: ReleaseBinding;
      let generatedBy: 'occ' | 'direct';

      try {
        const result = await runOccReleaseBindingGenerate(
          occBin,
          args,
          workspaceRoot,
          occEnvironment.env,
        );

        if (result.ok) {
          if (result.stdout.trim()) {
            ctx.logger.info(`OCC: ${result.stdout.trim()}`);
          }

          if (result.stderr.trim()) {
            ctx.logger.info(`OCC stderr: ${result.stderr.trim()}`);
          }

          const generatedPath = await locateGeneratedBinding(
            absolutePath,
            result.stdout,
          );

          if (!generatedPath) {
            throw new Error(
              `OCC completed without creating the expected ReleaseBinding: ${relativePath}`,
            );
          }

          if (generatedPath !== absolutePath) {
            await fs.mkdir(path.dirname(absolutePath), { recursive: true });
            await fs.copyFile(generatedPath, absolutePath);
          }

          let generated: ReleaseBinding | undefined;

          try {
            generated = await readReleaseBindingFile(absolutePath);
          } catch (error) {
            throw new Error(
              `OCC generated invalid YAML at ${relativePath}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }

          if (!generated) {
            throw new Error(
              `OCC generated an invalid ReleaseBinding manifest: ${relativePath}`,
            );
          }

          manifest = generated;
          generatedBy = 'occ';
        } else if (
          generationMode === 'occ' ||
          !isMissingRepositoryMetadata(result)
        ) {
          throw new Error(
            `OCC failed to generate the ReleaseBinding for ${component} in ${environment}: ${result.message}`,
          );
        } else {
          ctx.logger.warn(
            `OCC could not resolve the OpenChoreo resources of the fetched GitOps repository (${result.message.trim()}). The canonical ReleaseBinding is written from the promotion inputs instead, so the binding is not validated against the repository Project, DeploymentPipeline and ComponentRelease resources.`,
          );

          const canonical = buildReleaseBinding(
            namespace,
            project,
            component,
            environment,
            releaseName,
          );

          manifest = existingBinding
            ? mergeReleaseBinding(existingBinding, canonical)
            : canonical;

          await writeReleaseBindingFile(absolutePath, manifest);

          generatedBy = 'direct';
        }
      } finally {
        await occEnvironment.cleanup();
      }

      if (
        manifest.apiVersion !== releaseBindingApiVersion ||
        manifest.kind !== releaseBindingKind
      ) {
        throw new Error(
          `OCC generated an unexpected resource type at ${relativePath}`,
        );
      }

      if (
        manifest.metadata?.name !== `${component}-${environment}` ||
        manifest.metadata?.namespace !== namespace ||
        manifest.spec?.owner?.projectName !== project ||
        manifest.spec?.owner?.componentName !== component ||
        manifest.spec?.environment !== environment ||
        manifest.spec?.releaseName !== releaseName
      ) {
        throw new Error(
          `OCC-generated ReleaseBinding does not match the requested identity or release: ${relativePath}. Check the active OCC context and generated manifest.`,
        );
      }

      const changed = !existingBinding
        ? true
        : !isSameReleaseBinding(existingBinding, manifest);

      if (!changed) {
        ctx.logger.warn(
          `The generated ReleaseBinding is identical to the one already present in the target branch (${relativePath}). The promotion pull request will not contain a change for it.`,
        );
      }

      // Keep the existing Backstage GitHub PR workflow intact.
      const stagingRelativePath = path.posix.join(
        'promotion-staging',
        `${component}-${environment}.yaml`,
      );
      const stagingAbsolutePath = path.resolve(
        workspaceRoot,
        stagingRelativePath,
      );

      if (!stagingAbsolutePath.startsWith(`${workspaceRoot}${path.sep}`)) {
        throw new Error('Invalid promotion staging path');
      }

      await fs.mkdir(path.dirname(stagingAbsolutePath), {
        recursive: true,
      });

      await fs.copyFile(absolutePath, stagingAbsolutePath);

      ctx.output('filePath', relativePath);
      ctx.output('stagingPath', stagingRelativePath);
      ctx.output('operation', operation);
      ctx.output('generatedBy', generatedBy);
      ctx.output('changed', changed);

      ctx.logger.info(
        `ReleaseBinding ${operation} by ${
          generatedBy === 'occ' ? 'OCC' : 'the action'
        }: ${relativePath}`,
      );
      ctx.logger.info(
        `ReleaseBinding staged for GitHub PR: ${stagingRelativePath}`,
      );
    },
  });
