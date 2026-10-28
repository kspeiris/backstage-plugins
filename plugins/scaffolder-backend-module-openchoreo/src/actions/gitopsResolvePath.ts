import path from 'node:path';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';

const dnsNamePattern = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const environmentPattern = /^[a-zA-Z0-9]([-a-zA-Z0-9]*[a-zA-Z0-9])?$/;

/**
 * Resolve the canonical GitOps path used by the ReleaseBinding generator.
 * Keep this mapping in one place so conflict checks and PR descriptions refer
 * to the exact file that OCC generation writes.
 */
export const createGitOpsResolvePathAction = () =>
  createTemplateAction({
    id: 'openchoreo:gitops:resolve-path',
    description: 'Resolve the GitOps manifest path for a promotion',
    schema: {
      input: {
        namespace: z => z.string().min(1).regex(dnsNamePattern),
        project: z => z.string().min(1).regex(dnsNamePattern),
        component: z => z.string().min(1).regex(dnsNamePattern),
        targetEnvironment: z => z.string().min(1).regex(environmentPattern),
      },
      output: {
        targetPath: z => z.string(),
      },
    },
    async handler(ctx) {
      const values = {
        namespace: ctx.input.namespace.trim(),
        project: ctx.input.project.trim(),
        component: ctx.input.component.trim(),
        targetEnvironment: ctx.input.targetEnvironment.trim(),
      };

      if (
        !dnsNamePattern.test(values.namespace) ||
        !dnsNamePattern.test(values.project) ||
        !dnsNamePattern.test(values.component) ||
        !environmentPattern.test(values.targetEnvironment)
      ) {
        throw new Error('Invalid GitOps promotion path inputs');
      }

      const targetPath = path.posix.join(
        'projects',
        values.project,
        'components',
        values.component,
        'release-bindings',
        `${values.component}-${values.targetEnvironment}.yaml`,
      );

      if (targetPath.startsWith('/') || targetPath.split('/').includes('..')) {
        throw new Error('Resolved GitOps path is outside the repository');
      }

      ctx.output('targetPath', targetPath);
      ctx.logger.info(`Resolved GitOps promotion path: ${targetPath}`);
    },
  });
