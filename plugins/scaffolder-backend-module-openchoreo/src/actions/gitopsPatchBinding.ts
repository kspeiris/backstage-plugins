import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import fs from 'node:fs/promises';
import path from 'node:path';
import { patchReleaseBindingManifest } from '@openchoreo/backstage-plugin-common';

const dnsNamePattern = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const environmentPattern = /^[a-zA-Z0-9]([-a-zA-Z0-9]*[a-zA-Z0-9])?$/;

const isWithinWorkspace = (workspaceRoot: string, filePath: string): boolean =>
  filePath.startsWith(`${workspaceRoot}${path.sep}`);

const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ENOENT';

export const createGitOpsPatchBindingAction = () =>
  createTemplateAction({
    id: 'openchoreo:gitops:patch-binding',
    description:
      'Patch override values in an existing OpenChoreo ReleaseBinding manifest',
    schema: {
      input: {
        namespace: z => z.string().min(1).regex(dnsNamePattern),
        project: z => z.string().min(1).regex(dnsNamePattern),
        component: z => z.string().min(1).regex(dnsNamePattern),
        targetEnvironment: z => z.string().min(1).regex(environmentPattern),
        componentTypeEnvironmentConfigs: z => z.record(z.unknown()).optional(),
        traitEnvironmentConfigs: z => z.record(z.unknown()).optional(),
        workloadOverrides: z => z.record(z.unknown()).optional(),
      },
      output: {
        filePath: z => z.string(),
        stagingPath: z => z.string(),
        changed: z => z.boolean(),
      },
    },
    async handler(ctx) {
      const namespace = ctx.input.namespace.trim();
      const project = ctx.input.project.trim();
      const component = ctx.input.component.trim();
      const environment = ctx.input.targetEnvironment.trim();

      if (
        !dnsNamePattern.test(namespace) ||
        !dnsNamePattern.test(project) ||
        !dnsNamePattern.test(component) ||
        !environmentPattern.test(environment)
      ) {
        throw new Error(
          'One or more ReleaseBinding identity inputs are invalid',
        );
      }

      const patches = {
        componentTypeEnvironmentConfigs:
          ctx.input.componentTypeEnvironmentConfigs,
        traitEnvironmentConfigs: ctx.input.traitEnvironmentConfigs,
        workloadOverrides: ctx.input.workloadOverrides,
      };

      const hasPatches = Object.values(patches).some(v => v !== undefined);
      if (!hasPatches) {
        throw new Error('At least one override section must be provided');
      }

      const relativePath = path.posix.join(
        'projects',
        project,
        'components',
        component,
        'release-bindings',
        `${component}-${environment}.yaml`,
      );
      const workspaceRoot = await fs.realpath(ctx.workspacePath);
      const absolutePath = path.resolve(workspaceRoot, relativePath);

      if (!isWithinWorkspace(workspaceRoot, absolutePath)) {
        throw new Error('ReleaseBinding path escapes the workspace');
      }

      let existingRealPath: string;
      try {
        existingRealPath = await fs.realpath(absolutePath);
      } catch (error) {
        if (isMissingFileError(error)) {
          throw new Error(`ReleaseBinding manifest not found: ${relativePath}`);
        }
        throw error;
      }

      if (!isWithinWorkspace(workspaceRoot, existingRealPath)) {
        throw new Error(
          'ReleaseBinding manifest resolves outside the workspace',
        );
      }

      const source = await fs.readFile(existingRealPath, 'utf8');

      // Use shared patch logic
      const patchResult = patchReleaseBindingManifest(
        source,
        namespace,
        project,
        component,
        environment,
        patches,
      );

      const stagingRelativePath = path.posix.join(
        'promotion-staging',
        `${component}-${environment}.yaml`,
      );
      const stagingDirectory = path.resolve(workspaceRoot, 'promotion-staging');
      if (!isWithinWorkspace(workspaceRoot, stagingDirectory)) {
        throw new Error('Promotion staging path escapes the workspace');
      }
      await fs.mkdir(stagingDirectory, { recursive: true });
      const stagingRealDirectory = await fs.realpath(stagingDirectory);
      if (!isWithinWorkspace(workspaceRoot, stagingRealDirectory)) {
        throw new Error(
          'Promotion staging directory resolves outside the workspace',
        );
      }

      if (patchResult.changed) {
        await fs.writeFile(existingRealPath, patchResult.proposedYaml, 'utf8');
      }
      const stagingFilePath = path.join(
        stagingRealDirectory,
        `${component}-${environment}.yaml`,
      );
      let stagingTargetPath = stagingFilePath;
      try {
        stagingTargetPath = await fs.realpath(stagingFilePath);
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
      if (!isWithinWorkspace(workspaceRoot, stagingTargetPath)) {
        throw new Error(
          'Promotion staging file resolves outside the workspace',
        );
      }
      await fs.writeFile(stagingTargetPath, patchResult.proposedYaml, 'utf8');

      ctx.output('filePath', relativePath);
      ctx.output('stagingPath', stagingRelativePath);
      ctx.output('changed', patchResult.changed);
      ctx.logger.info(
        `ReleaseBinding overrides ${
          patchResult.changed ? 'patched' : 'unchanged'
        }: ${relativePath}`,
      );
    },
  });
