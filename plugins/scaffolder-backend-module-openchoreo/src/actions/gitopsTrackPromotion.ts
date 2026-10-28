import type {
  AuthService,
  DiscoveryService,
} from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';

function getPullRequestNumber(
  repositoryUrl: string,
  pullRequestUrl: string,
): number {
  let repository: URL;
  let pullRequest: URL;
  try {
    repository = new URL(repositoryUrl);
    pullRequest = new URL(pullRequestUrl);
  } catch {
    throw new Error('GitHub repository and pull request URLs must be valid');
  }

  const repositoryParts = repository.pathname.split('/').filter(Boolean);
  const pullRequestParts = pullRequest.pathname.split('/').filter(Boolean);
  const pullRequestNumber = Number(pullRequestParts[3]);
  if (
    repository.protocol !== 'https:' ||
    repository.hostname !== 'github.com' ||
    repository.username ||
    repository.password ||
    repository.search ||
    repository.hash ||
    repositoryParts.length !== 2 ||
    pullRequest.protocol !== 'https:' ||
    pullRequest.hostname !== 'github.com' ||
    pullRequest.username ||
    pullRequest.password ||
    pullRequest.search ||
    pullRequest.hash ||
    pullRequestParts.length !== 4 ||
    pullRequestParts[2] !== 'pull' ||
    !/^[1-9]\d*$/.test(pullRequestParts[3]) ||
    !Number.isSafeInteger(pullRequestNumber) ||
    repositoryParts[0].toLowerCase() !== pullRequestParts[0].toLowerCase() ||
    repositoryParts[1].replace(/\.git$/, '').toLowerCase() !==
      pullRequestParts[1].replace(/\.git$/, '').toLowerCase()
  ) {
    throw new Error(
      'The created pull request URL does not match the selected GitHub repository',
    );
  }

  return pullRequestNumber;
}

export const createGitOpsTrackPromotionAction = ({
  auth,
  discovery,
}: {
  auth: AuthService;
  discovery: DiscoveryService;
}) =>
  createTemplateAction({
    id: 'openchoreo:gitops:track-promotion',
    description:
      'Record a created GitHub pull request in the OpenChoreo GitOps tracker',
    schema: {
      input: {
        namespace: z => z.string().min(1),
        project: z => z.string().min(1),
        component: z => z.string().min(1),
        targetEnvironment: z => z.string().min(1),
        repositoryUrl: z => z.string().url(),
        pullRequestUrl: z => z.string().url(),
      },
      output: {
        pullRequestNumber: z => z.number(),
        pullRequestUrl: z => z.string(),
      },
    },
    async handler(ctx) {
      const pullRequestNumber = getPullRequestNumber(
        ctx.input.repositoryUrl,
        ctx.input.pullRequestUrl,
      );
      const baseUrl = await discovery.getBaseUrl('openchoreo');
      const credentials = await auth.getOwnServiceCredentials();
      const { token } = await auth.getPluginRequestToken({
        onBehalfOf: credentials,
        targetPluginId: 'openchoreo',
      });
      const userToken = ctx.secrets?.OPENCHOREO_USER_TOKEN;
      const response = await fetch(
        `${baseUrl.replace(/\/$/, '')}/gitops/promotions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(userToken ? { 'x-openchoreo-token': userToken } : {}),
          },
          body: JSON.stringify({
            namespaceName: ctx.input.namespace,
            projectName: ctx.input.project,
            componentName: ctx.input.component,
            environment: ctx.input.targetEnvironment,
            repositoryUrl: ctx.input.repositoryUrl,
            pullRequestUrl: ctx.input.pullRequestUrl,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(
          `Failed to record GitOps pull request (HTTP ${response.status})`,
        );
      }

      ctx.output('pullRequestNumber', pullRequestNumber);
      ctx.output('pullRequestUrl', ctx.input.pullRequestUrl);
      ctx.logger.info(
        `Recorded GitHub pull request #${pullRequestNumber} for ${ctx.input.namespace}/${ctx.input.project}/${ctx.input.component} in ${ctx.input.targetEnvironment}`,
      );
    },
  });
