import type {
  DatabaseService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import type {
  GitOpsOwnership,
  GitOpsOwnershipState,
} from '@openchoreo/backstage-plugin-common';
import { ConflictError, InputError, NotFoundError } from '@backstage/errors';

const TABLE_NAME = 'openchoreo_gitops_ownership';

type KnexClient = Awaited<ReturnType<DatabaseService['getClient']>>;

export interface GitOpsOwnershipInput {
  namespaceName: string;
  projectName: string;
  componentName: string;
  environment: string;
  ownership: GitOpsOwnershipState;
  repositoryProvider?: string;
  repositoryOwner?: string;
  repositoryName?: string;
  baseBranch?: string;
  manifestPath?: string;
}

export function validateGitOpsOwnershipInput(
  input: GitOpsOwnershipInput,
): void {
  if (
    input.ownership === 'GITOPS_MANAGED' &&
    (!input.repositoryOwner ||
      !input.repositoryName ||
      !input.baseBranch ||
      !input.manifestPath)
  ) {
    throw new InputError(
      'GITOPS_MANAGED ownership requires repositoryOwner, repositoryName, baseBranch, and manifestPath',
    );
  }

  if (
    input.manifestPath &&
    (input.manifestPath.startsWith('/') ||
      input.manifestPath.split(/[\\/]/).includes('..') ||
      input.manifestPath.includes('\\'))
  ) {
    throw new InputError('manifestPath must be a repository-relative path');
  }
}

export function readGitOpsOwnershipBootstrapMappings(
  config: Config | undefined,
): GitOpsOwnershipInput[] {
  const mappings = config?.getOptionalConfigArray('bootstrapMappings') ?? [];
  return mappings.map(mappingConfig => {
    const ownershipValue = mappingConfig.getString('ownership');
    if (
      ownershipValue !== 'GITOPS_MANAGED' &&
      ownershipValue !== 'API_MANAGED' &&
      ownershipValue !== 'UNKNOWN'
    ) {
      throw new InputError(
        `Invalid ownership state in openchoreo.gitops.bootstrapMappings: ${ownershipValue}`,
      );
    }

    const mapping: GitOpsOwnershipInput = {
      namespaceName: mappingConfig.getString('namespaceName'),
      projectName: mappingConfig.getString('projectName'),
      componentName: mappingConfig.getString('componentName'),
      environment: mappingConfig.getString('environment'),
      ownership: ownershipValue,
      repositoryProvider: mappingConfig.getOptionalString('repositoryProvider'),
      repositoryOwner: mappingConfig.getOptionalString('repositoryOwner'),
      repositoryName: mappingConfig.getOptionalString('repositoryName'),
      baseBranch: mappingConfig.getOptionalString('baseBranch'),
      manifestPath: mappingConfig.getOptionalString('manifestPath'),
    };
    validateGitOpsOwnershipInput(mapping);
    return mapping;
  });
}

interface GitOpsOwnershipRow {
  namespace_name: string;
  project_name: string;
  component_name: string;
  environment: string;
  ownership: GitOpsOwnershipState;
  repository_provider: string | null;
  repository_owner: string | null;
  repository_name: string | null;
  base_branch: string | null;
  manifest_path: string | null;
  created_at: string | Date;
  updated_at: string | Date;
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

export async function applyGitOpsOwnershipMigrations(
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
      table.string('ownership', 32).notNullable();
      table.string('repository_provider', 64).nullable();
      table.string('repository_owner', 255).nullable();
      table.string('repository_name', 255).nullable();
      table.string('base_branch', 255).nullable();
      table.string('manifest_path', 2048).nullable();
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

export class GitOpsOwnershipService {
  constructor(private readonly knex: KnexClient) {}

  async createOwnership(input: GitOpsOwnershipInput): Promise<GitOpsOwnership> {
    validateGitOpsOwnershipInput(input);
    const now = this.knex.fn.now();
    try {
      await this.knex(TABLE_NAME).insert({
        ...this.toRow(input, now),
        created_at: now,
      });
    } catch (error) {
      const code =
        error instanceof Error
          ? (error as Error & { code?: string }).code
          : undefined;
      if (
        code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
        code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        code === '23505' ||
        String(error).toLowerCase().includes('unique constraint')
      ) {
        throw new ConflictError('Ownership mapping already exists');
      }
      throw error;
    }

    return this.getOwnership(input);
  }

  async updateOwnership(input: GitOpsOwnershipInput): Promise<GitOpsOwnership> {
    validateGitOpsOwnershipInput(input);
    const updated = await this.knex(TABLE_NAME)
      .where({
        namespace_name: input.namespaceName,
        project_name: input.projectName,
        component_name: input.componentName,
        environment: input.environment,
      })
      .update(this.toRow(input, this.knex.fn.now()));

    if (!updated) {
      throw new NotFoundError('Ownership mapping was not found');
    }

    return this.getOwnership(input);
  }

  async deleteOwnership(input: {
    namespaceName: string;
    projectName: string;
    componentName: string;
    environment: string;
  }): Promise<void> {
    const deleted = await this.knex(TABLE_NAME)
      .where({
        namespace_name: input.namespaceName,
        project_name: input.projectName,
        component_name: input.componentName,
        environment: input.environment,
      })
      .update({
        ownership: 'UNKNOWN',
        repository_provider: null,
        repository_owner: null,
        repository_name: null,
        base_branch: null,
        manifest_path: null,
        updated_at: this.knex.fn.now(),
      });

    if (!deleted) {
      throw new NotFoundError('Ownership mapping was not found');
    }
  }

  async bootstrapOwnershipMappings(
    mappings: GitOpsOwnershipInput[],
  ): Promise<void> {
    for (const mapping of mappings) {
      validateGitOpsOwnershipInput(mapping);
    }

    if (mappings.length === 0) {
      return;
    }

    await this.knex(TABLE_NAME)
      .insert(
        mappings.map(mapping => ({
          ...this.toRow(mapping, this.knex.fn.now()),
          created_at: this.knex.fn.now(),
        })),
      )
      .onConflict([
        'namespace_name',
        'project_name',
        'component_name',
        'environment',
      ])
      .ignore();
  }

  private toRow(input: GitOpsOwnershipInput, now: unknown) {
    return {
      namespace_name: input.namespaceName,
      project_name: input.projectName,
      component_name: input.componentName,
      environment: input.environment,
      ownership: input.ownership,
      repository_provider: input.repositoryProvider ?? 'github',
      repository_owner: input.repositoryOwner ?? null,
      repository_name: input.repositoryName ?? null,
      base_branch: input.baseBranch ?? null,
      manifest_path: input.manifestPath ?? null,
      updated_at: now,
    };
  }

  async getOwnership(input: {
    namespaceName: string;
    projectName: string;
    componentName: string;
    environment: string;
  }): Promise<GitOpsOwnership> {
    const row = await this.knex<GitOpsOwnershipRow>(TABLE_NAME)
      .where({
        namespace_name: input.namespaceName,
        project_name: input.projectName,
        component_name: input.componentName,
        environment: input.environment,
      })
      .first();

    if (!row) {
      return {
        namespaceName: input.namespaceName,
        projectName: input.projectName,
        componentName: input.componentName,
        environment: input.environment,
        ownership: 'UNKNOWN',
        repositoryConfigured: false,
      };
    }

    const repositoryOwner = row.repository_owner ?? undefined;
    const repositoryName = row.repository_name ?? undefined;
    const repository =
      repositoryOwner && repositoryName
        ? `${repositoryOwner}/${repositoryName}`
        : undefined;

    return {
      namespaceName: row.namespace_name,
      projectName: row.project_name,
      componentName: row.component_name,
      environment: row.environment,
      ownership: row.ownership,
      repositoryProvider: row.repository_provider ?? 'github',
      repositoryOwner,
      repositoryName,
      repository,
      baseBranch: row.base_branch ?? undefined,
      manifestPath: row.manifest_path ?? undefined,
      repositoryConfigured: Boolean(repositoryOwner && repositoryName),
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : new Date(row.updated_at).toISOString(),
    };
  }
}
