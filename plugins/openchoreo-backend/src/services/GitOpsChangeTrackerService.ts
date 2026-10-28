import type {
  DatabaseService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import type { GithubCredentialsProvider } from '@backstage/integration';
import type { GitOpsChangeStatus } from '@openchoreo/backstage-plugin-common';

const TABLE_NAME = 'openchoreo_gitops_promotions';

type KnexClient = Awaited<ReturnType<DatabaseService['getClient']>>;

export interface GitOpsPromotionInput {
  namespaceName: string;
  projectName: string;
  componentName: string;
  environment: string;
  repositoryOwner: string;
  repositoryName: string;
  pullRequestNumber: number;
}

interface GitOpsPromotionRow {
  namespace_name: string;
  project_name: string;
  component_name: string;
  environment: string;
  repository_owner: string;
  repository_name: string;
  pull_request_number: number;
  pull_request_url: string;
  pull_request_state: GitOpsChangeStatus['pullRequest']['state'];
  merge_commit_sha: string | null;
  last_checked_at: string | null;
  created_at: string | Date;
}

export interface GitOpsPullRequestStatus {
  number?: number;
  url?: string;
  state: GitOpsChangeStatus['pullRequest']['state'];
  mergeCommitSha?: string;
  promotedAt?: string;
  lastCheckedAt?: string;
  isStale?: boolean;
}

function isDuplicateObjectError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  const code =
    error instanceof Error
      ? (error as Error & { code?: string }).code
      : undefined;

  return (
    message.includes('already exists') ||
    message.includes('duplicate') ||
    code === '42P07' ||
    code === '42710' ||
    code === 'ER_TABLE_EXISTS_ERROR'
  );
}

export async function applyGitOpsChangeTrackerMigrations(
  knex: KnexClient,
  logger: LoggerService,
): Promise<void> {
  if (await knex.schema.hasTable(TABLE_NAME)) {
    return;
  }

  try {
    await knex.schema.createTable(TABLE_NAME, table => {
      table.string('namespace_name', 255).notNullable();
      table.string('project_name', 255).notNullable();
      table.string('component_name', 255).notNullable();
      table.string('environment', 255).notNullable();
      table.string('repository_owner', 255).notNullable();
      table.string('repository_name', 255).notNullable();
      table.integer('pull_request_number').notNullable();
      table.string('pull_request_url', 2048).notNullable();
      table.string('pull_request_state', 32).notNullable();
      table.string('merge_commit_sha', 128).nullable();
      table.timestamp('last_checked_at').nullable();
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      table.primary([
        'namespace_name',
        'project_name',
        'component_name',
        'environment',
      ]);
    });
  } catch (error) {
    if (!isDuplicateObjectError(error)) {
      throw error;
    }

    logger.warn(
      `Table ${TABLE_NAME} already exists, skipping creation after concurrent startup`,
      { error: String(error) },
    );
  }
}

export class GitOpsChangeTrackerService {
  constructor(
    private readonly knex: KnexClient,
    private readonly logger: LoggerService,
    private readonly githubCredentialsProvider?: GithubCredentialsProvider,
    private readonly githubFetch: typeof fetch = fetch,
  ) {}

  async recordPromotion(input: GitOpsPromotionInput): Promise<void> {
    const now = this.knex.fn.now();
    const repositoryValues = {
      repository_owner: input.repositoryOwner,
      repository_name: input.repositoryName,
      pull_request_number: input.pullRequestNumber,
      pull_request_url: `https://github.com/${input.repositoryOwner}/${input.repositoryName}/pull/${input.pullRequestNumber}`,
      pull_request_state: 'OPEN' as const,
      merge_commit_sha: null,
      last_checked_at: null,
      updated_at: now,
    };

    await this.knex(TABLE_NAME)
      .insert({
        namespace_name: input.namespaceName,
        project_name: input.projectName,
        component_name: input.componentName,
        environment: input.environment,
        ...repositoryValues,
        created_at: now,
      })
      .onConflict([
        'namespace_name',
        'project_name',
        'component_name',
        'environment',
      ])
      .merge({
        ...repositoryValues,
        created_at: now,
      });
  }

  async getPullRequestStatus(input: {
    namespaceName: string;
    projectName: string;
    componentName: string;
    environment: string;
  }): Promise<GitOpsPullRequestStatus> {
    const row = await this.knex<GitOpsPromotionRow>(TABLE_NAME)
      .where({
        namespace_name: input.namespaceName,
        project_name: input.projectName,
        component_name: input.componentName,
        environment: input.environment,
      })
      .first();

    if (!row) {
      return { state: 'NOT_CREATED' };
    }

    const repositoryUrl = `https://github.com/${row.repository_owner}/${row.repository_name}`;
    const pullRequestUrl = `https://api.github.com/repos/${encodeURIComponent(
      row.repository_owner,
    )}/${encodeURIComponent(row.repository_name)}/pulls/${
      row.pull_request_number
    }`;

    const staleStatus: GitOpsPullRequestStatus = {
      number: row.pull_request_number,
      url: row.pull_request_url,
      state: row.pull_request_state,
      mergeCommitSha: row.merge_commit_sha ?? undefined,
      promotedAt: new Date(row.created_at).toISOString(),
      lastCheckedAt: row.last_checked_at ?? undefined,
      isStale: true,
    };

    let response: Response | undefined;
    try {
      const credentials = await this.githubCredentialsProvider?.getCredentials({
        url: repositoryUrl,
      });
      response = await this.githubFetch(pullRequestUrl, {
        headers: {
          Accept: 'application/vnd.github+json',
          ...credentials?.headers,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      this.logger.warn(
        `Unable to refresh GitHub status for ${row.repository_owner}/${row.repository_name}#${row.pull_request_number}`,
      );
      return staleStatus;
    }

    if (!response?.ok) {
      this.logger.warn(
        `GitHub status refresh returned HTTP ${
          response?.status ?? 'unknown'
        } for ${row.repository_owner}/${row.repository_name}#${
          row.pull_request_number
        }`,
      );
      return staleStatus;
    }

    let pullRequest: {
      state?: unknown;
      merged_at?: unknown;
      merge_commit_sha?: unknown;
    };
    try {
      pullRequest = (await response.json()) as typeof pullRequest;
    } catch {
      this.logger.warn(
        `GitHub returned an invalid pull request response for ${row.repository_owner}/${row.repository_name}#${row.pull_request_number}`,
      );
      return staleStatus;
    }

    if (
      (pullRequest.state !== 'open' && pullRequest.state !== 'closed') ||
      (pullRequest.merged_at != null &&
        typeof pullRequest.merged_at !== 'string')
    ) {
      this.logger.warn(
        `GitHub returned an unexpected pull request state for ${row.repository_owner}/${row.repository_name}#${row.pull_request_number}`,
      );
      return staleStatus;
    }

    const isMerged =
      pullRequest.state === 'closed' && Boolean(pullRequest.merged_at);
    const state: GitOpsChangeStatus['pullRequest']['state'] = isMerged
      ? 'MERGED'
      : pullRequest.state === 'closed'
      ? 'CLOSED'
      : 'OPEN';
    const checkedAt = new Date().toISOString();
    const mergeCommitSha =
      isMerged && typeof pullRequest.merge_commit_sha === 'string'
        ? pullRequest.merge_commit_sha
        : undefined;

    await this.knex(TABLE_NAME)
      .where({
        namespace_name: input.namespaceName,
        project_name: input.projectName,
        component_name: input.componentName,
        environment: input.environment,
      })
      .update({
        pull_request_state: state,
        merge_commit_sha: mergeCommitSha ?? null,
        last_checked_at: checkedAt,
        updated_at: checkedAt,
      });

    return {
      number: row.pull_request_number,
      url: row.pull_request_url,
      state,
      mergeCommitSha,
      promotedAt: new Date(row.created_at).toISOString(),
      lastCheckedAt: checkedAt,
      isStale: false,
    };
  }
}
