import { createTemplateAction } from '@backstage/plugin-scaffolder-node';

export const createGitOpsValidateAction = () => {
  return createTemplateAction({
    id: 'openchoreo:gitops:validate',

    description:
      'Validate the required inputs for a PR-driven OpenChoreo GitOps promotion',

    schema: {
      input: {
        namespace: z =>
          z
            .string({ description: 'OpenChoreo namespace name' })
            .min(1, 'Namespace is required')
            .regex(
              /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
              'Namespace must be a valid lowercase DNS-style name',
            ),

        project: z =>
          z
            .string({ description: 'OpenChoreo project name' })
            .min(1, 'Project is required')
            .regex(
              /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
              'Project must be a valid lowercase DNS-style name',
            ),

        component: z =>
          z
            .string({ description: 'OpenChoreo component name' })
            .min(1, 'Component is required')
            .regex(
              /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
              'Component must be a valid lowercase DNS-style name',
            ),

        targetEnvironment: z =>
          z
            .string({ description: 'Target deployment environment' })
            .min(1, 'Target environment is required')
            .regex(
              /^[a-zA-Z0-9]([-a-zA-Z0-9]*[a-zA-Z0-9])?$/,
              'Target environment must contain only letters, numbers, and hyphens',
            ),
      },

      output: {
        namespace: z => z.string(),
        project: z => z.string(),
        component: z => z.string(),
        targetEnvironment: z => z.string(),
        validationStatus: z => z.string(),
      },
    },

    async handler(ctx) {
      const {
        namespace,
        project,
        component,
        targetEnvironment,
      } = ctx.input;

      ctx.logger.info(
        `Validating GitOps promotion inputs for ${namespace}/${project}/${component}`,
      );

      // Normalize whitespace around user-provided values.
      const normalized = {
        namespace: namespace.trim(),
        project: project.trim(),
        component: component.trim(),
        targetEnvironment: targetEnvironment.trim(),
      };

      // The input schema handles the main validation rules.
      // These checks also protect against whitespace-only values.
      for (const [field, value] of Object.entries(normalized)) {
        if (!value) {
          throw new Error(`${field} must not be empty`);
        }
      }

      ctx.output('namespace', normalized.namespace);
      ctx.output('project', normalized.project);
      ctx.output('component', normalized.component);
      ctx.output(
        'targetEnvironment',
        normalized.targetEnvironment,
      );
      ctx.output('validationStatus', 'valid');

      ctx.logger.info(
        'GitOps promotion inputs passed validation',
      );
    },
  });
};
