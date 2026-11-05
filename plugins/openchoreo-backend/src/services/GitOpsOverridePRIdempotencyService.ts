import type {
  DatabaseService,
  LoggerService,
} from '@backstage/backend-plugin-api';

const TABLE_NAME = 'openchoreo_gitops_override_pr_idempotency';

type KnexClient = Awaited<ReturnType<DatabaseService['getClient']>>;

export interface IdempotencyRecord {
  key: string;
  namespaceName: string;
  projectName: string;
  componentName: string;
  environment: string;
  requestHash: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  branchName?: string | null;
  commitSha?: string | null;
  pullRequestNumber?: number | null;
  pullRequestUrl?: string | null;
  pullRequestTitle?: string | null;
  baseBranch?: string | null;
  error?: string | null;
  resultJson?: string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  expiresAt?: string | Date;
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

export async function applyGitOpsOverridePRIdempotencyMigrations(
  knex: KnexClient,
  logger: LoggerService,
): Promise<void> {
  if (await knex.schema.hasTable(TABLE_NAME)) {
    return;
  }

  try {
    await knex.schema.createTable(TABLE_NAME, table => {
      table.string('key', 255).primary();
      table.string('namespace_name', 255).notNullable();
      table.string('project_name', 255).notNullable();
      table.string('component_name', 255).notNullable();
      table.string('environment', 255).notNullable();
      table.string('request_hash', 64).notNullable();
      table.string('status', 32).notNullable();
      table.string('branch_name', 255).nullable();
      table.string('commit_sha', 128).nullable();
      table.integer('pull_request_number').nullable();
      table.string('pull_request_url', 2048).nullable();
      table.string('pull_request_title', 512).nullable();
      table.string('base_branch', 255).nullable();
      table.text('error').nullable();
      table.text('result_json').nullable();
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('expires_at').nullable();
      table.index(['namespace_name', 'project_name', 'component_name', 'environment']);
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

export class GitOpsOverridePRIdempotencyService {
  constructor(private readonly knex: KnexClient) {}

  async get(key: string): Promise<IdempotencyRecord | null> {
    const row = await this.knex(TABLE_NAME).where({ key }).first();
    if (!row) {
      return null;
    }
    return this.mapRow(row);
  }

  async createInProgress(record: IdempotencyRecord): Promise<void> {
    const now = this.knex.fn.now();
    const expiresAt = this.knex.raw("datetime('now', '+7 days')");
    try {
      await this.knex(TABLE_NAME).insert({
        key: record.key,
        namespace_name: record.namespaceName,
        project_name: record.projectName,
        component_name: record.componentName,
        environment: record.environment,
        request_hash: record.requestHash,
        status: 'IN_PROGRESS',
        branch_name: record.branchName ?? null,
        created_at: now,
        updated_at: now,
        expires_at: expiresAt,
      });
    } catch (error) {
      // ignore duplicate insert (race)
    }
  }

  async updateCompleted(
    key: string,
    updates: Partial<IdempotencyRecord>,
  ): Promise<void> {
    const now = this.knex.fn.now();
    await this.knex(TABLE_NAME)
      .where({ key })
      .update({
        status: 'COMPLETED',
        branch_name: updates.branchName ?? null,
        commit_sha: updates.commitSha ?? null,
        pull_request_number: updates.pullRequestNumber ?? null,
        pull_request_url: updates.pullRequestUrl ?? null,
        pull_request_title: updates.pullRequestTitle ?? null,
        base_branch: updates.baseBranch ?? null,
        result_json: updates.resultJson ?? null,
        error: null,
        updated_at: now,
      });
  }

  async updateFailed(key: string, error: string): Promise<void> {
    const now = this.knex.fn.now();
    await this.knex(TABLE_NAME)
      .where({ key })
      .update({
        status: 'FAILED',
        error: error.slice(0, 4000),
        updated_at: now,
      });
  }

  async cleanupExpired(): Promise<number> {
    const now = this.knex.fn.now();
    return this.knex(TABLE_NAME)
      .where('expires_at', '<', now)
      .delete();
  }

  private mapRow(row: any): IdempotencyRecord {
    return {
      key: row.key,
      namespaceName: row.namespace_name,
      projectName: row.project_name,
      componentName: row.component_name,
      environment: row.environment,
      requestHash: row.request_hash,
      status: row.status,
      branchName: row.branch_name,
      commitSha: row.commit_sha,
      pullRequestNumber: row.pull_request_number,
      pullRequestUrl: row.pull_request_url,
      pullRequestTitle: row.pull_request_title,
      baseBranch: row.base_branch,
      error: row.error,
      resultJson: row.result_json,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  }
}
