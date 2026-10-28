import { createTemplateAction } from '@backstage/plugin-scaffolder-node';

const dnsNamePattern = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const environmentPattern = /^[a-zA-Z0-9]([-a-zA-Z0-9]*[a-zA-Z0-9])?$/;

type ExistingPullRequest = {
  number: number;
  title: string;
  url: string;
  state: string;
  author?: string;
};

type ConflictResult = {
  hasConflict: boolean;
  targetPath: string;
  existingPullRequest?: ExistingPullRequest;
};

const githubApiBase = 'https://api.github.com';

export const createGitOpsCheckConflictsAction = () =>
  createTemplateAction({
    id: 'openchoreo:gitops:check-conflicts',
    description: 'Check for conflicting open pull requests on a GitOps manifest path',
    schema: {
      input: {
        repository: z =>
          z
            .string()
            .min(1)
            .regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/),
        targetBranch: z => z.string().min(1),
        targetPath: z => z.string().min(1),
        namespace: z => z.string().min(1).regex(dnsNamePattern),
        project: z => z.string().min(1).regex(dnsNamePattern),
        component: z => z.string().min(1).regex(dnsNamePattern),
        targetEnvironment: z => z.string().min(1).regex(environmentPattern),
      },
      output: {
        hasConflict: z => z.boolean(),
        targetPath: z => z.string(),
        existingPullRequest: z =>
          z
            .object({
              number: z.number(),
              title: z.string(),
              url: z.string(),
              state: z.string(),
              author: z.string().optional(),
            })
            .optional(),
      },
    },
    async handler(ctx) {
      const repository = ctx.input.repository.replace(/\/$/, '');
      const match = repository.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (!match) {
        throw new Error('Invalid GitHub repository URL');
      }
      const owner = match[1];
      const repo = match[2];
      const targetPath = ctx.input.targetPath;
      const targetBranch = ctx.input.targetBranch;

      const token =
        process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

      if (!token) {
        throw new Error(
          'GitHub token is not configured; cannot check for conflicting pull requests',
        );
      }

      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      };

      const pullsResponse = await fetch(
        `${githubApiBase}/repos/${owner}/${repo}/pulls?state=open&base=${encodeURIComponent(
          targetBranch,
        )}&per_page=100`,
        { headers },
      );

      if (!pullsResponse.ok) {
        throw new Error(
          `Failed to list pull requests: ${pullsResponse.status} ${pullsResponse.statusText}`,
        );
      }

      const pulls = (await pullsResponse.json()) as Array<{
        number: number;
        title: string;
        html_url: string;
        state: string;
        user?: { login?: string };
      }>;

      let conflict: ExistingPullRequest | undefined;

      for (const pull of pulls) {
        const filesResponse = await fetch(
          `${githubApiBase}/repos/${owner}/${repo}/pulls/${pull.number}/files?per_page=100`,
          { headers },
        );

        if (!filesResponse.ok) {
          throw new Error(
            `Failed to list files for pull request #${pull.number}: ${filesResponse.status} ${filesResponse.statusText}`,
          );
        }

        const files = (await filesResponse.json()) as Array<{ filename: string }>;

        if (files.some(file => file.filename === targetPath)) {
          conflict = {
            number: pull.number,
            title: pull.title,
            url: pull.html_url,
            state: pull.state,
            author: pull.user?.login,
          };
          break;
        }
      }

      const result: ConflictResult = {
        hasConflict: Boolean(conflict),
        targetPath,
        existingPullRequest: conflict,
      };

      ctx.output('hasConflict', result.hasConflict);
      ctx.output('targetPath', result.targetPath);
      ctx.output('existingPullRequest', result.existingPullRequest);

      if (result.hasConflict) {
        ctx.logger.warn(
          `Conflicting open pull request found: #${conflict?.number} modifies ${targetPath}`,
        );
      } else {
        ctx.logger.info(`No conflicting pull requests found for ${targetPath}`);
      }
    },
  });
