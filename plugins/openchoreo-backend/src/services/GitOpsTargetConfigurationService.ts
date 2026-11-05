import type {
  DatabaseService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import type {
  GitOpsTargetConfig,
  GitOpsTargetCoordinates,
} from '@openchoreo/backstage-plugin-common';
import { ConflictError, InputError, NotFoundError } from '@backstage/errors';

export const GITOPS_TARGETS_TABLE = 'openchoreo_gitops_ownership';

export type KnexClient = Awaited<ReturnType<DatabaseService['getClient']>>;

export interface GitOpsTargetInput {
  namespaceName: string;
  projectName: string;
  componentName: string;
  environment: string;
  repositoryProvider?: string;
  repositoryOwner: string;
  repositoryName: string;
  baseBranch: string;
  manifestPath: string;
}

export function validateGitOpsTargetInput(input: GitOpsTargetInput): void {
  if (
    !input.namespaceName?.trim() ||
    !input.projectName?.trim() ||
    !input.componentName?.trim() ||
    !input.environment?.trim()
  ) {
    throw new InputError(
      'Target coordinates (namespaceName, projectName, componentName, environment) are required',
    );
  }

  if (
    !input.repositoryOwner?.trim() ||
    !input.repositoryName?.trim() ||
    !input.baseBranch?.trim() ||
    !input.manifestPath?.trim()
  ) {
    throw new InputError(
      'GitOps target requires repositoryOwner, repositoryName, baseBranch, and manifestPath',
    );
  }

  if (input.repositoryProvider && input.repositoryProvider !== 'github') {
    throw new InputError('repositoryProvider must be github');
  }

  const manifestPath = input.manifestPath.trim();
  if (
    manifestPath.startsWith('/') ||
    manifestPath.split(/[\\/]/).includes('..') ||
    manifestPath.includes('\\')
  ) {
    throw new InputError('manifestPath must be a repository-relative path');
  }
}

export function readGitOpsTargetBootstrapMappings(
  config: Config | undefined,
): GitOpsTargetInput[] {
  const mappings = config?.getOptionalConfigArray('bootstrapMappings') ?? [];
  const results: GitOpsTargetInput[] = [];

  for (const mappingConfig of mappings) {
    const repositoryOwner = mappingConfig.getOptionalString('repositoryOwner');
    const repositoryName = mappingConfig.getOptionalString('repositoryName');
    const baseBranch = mappingConfig.getOptionalString('baseBranch');
    const manifestPath = mappingConfig.getOptionalString('manifestPath');

    // Only configure target mappings if repository coordinates are supplied
    if (!repositoryOwner || !repositoryName || !baseBranch || !manifestPath) {
      continue;
    }

    const mapping: GitOpsTargetInput = {
      namespaceName: mappingConfig.getString('namespaceName'),
      projectName: mappingConfig.getString('projectName'),
      componentName: mappingConfig.getString('componentName'),
      environment: mappingConfig.getString('environment'),
      repositoryProvider: mappingConfig.getOptionalString('repositoryProvider'),
      repositoryOwner,
      repositoryName,
      baseBranch,
      manifestPath,
    };
    validateGitOpsTargetInput(mapping);
    results.push(mapping);
  }

  return results;
}

interface GitOpsTargetRow {
  namespace_name: string;
  project_name: string;
  component_name: string;
  environment: string;
  ownership: string;
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

export async function applyGitOpsTargetMigrations(
  knex: KnexClient,
  logger: LoggerService,
): Promise<void> {
  if (await knex.schema.hasTable(GITOPS_TARGETS_TABLE)) {
    return;
  }

  try {
    await knex.schema.createTable(GITOPS_TARGETS_TABLE, table => {
      table.string('namespace_name', 255).notNullable();
      table.string('project_name', 255).notNullable();
      table.string('component_name', 255).notNullable();
      table.string('environment', 255).notNullable();
      table.string('ownership', 32).notNullable().defaultTo('GITOPS_MANAGED');
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
      `Table ${GITOPS_TARGETS_TABLE} already exists, skipping creation after concurrent startup`,
      { error: String(error) },
    );
  }
}

export class GitOpsTargetConfigurationService {
  constructor(private readonly knex: KnexClient) {}

  async createTarget(input: GitOpsTargetInput): Promise<GitOpsTargetConfig> {
    validateGitOpsTargetInput(input);
    const now = this.knex.fn.now();
    try {
      await this.knex(GITOPS_TARGETS_TABLE).insert({
        ...this.toRow(input, now),
        ownership: 'GITOPS_MANAGED',
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
        throw new ConflictError('GitOps target configuration already exists');
      }
      throw error;
    }

    return this.getTarget(input);
  }

  async updateTarget(input: GitOpsTargetInput): Promise<GitOpsTargetConfig> {
    validateGitOpsTargetInput(input);
    const updated = await this.knex(GITOPS_TARGETS_TABLE)
      .where({
        namespace_name: input.namespaceName,
        project_name: input.projectName,
        component_name: input.componentName,
        environment: input.environment,
      })
      .update({
        ...this.toRow(input, this.knex.fn.now()),
        ownership: 'GITOPS_MANAGED',
      });

    if (!updated) {
      throw new NotFoundError('GitOps target configuration was not found');
    }

    return this.getTarget(input);
  }

  async deleteTarget(coordinates: GitOpsTargetCoordinates): Promise<void> {
    const deleted = await this.knex(GITOPS_TARGETS_TABLE)
      .where({
        namespace_name: coordinates.namespaceName,
        project_name: coordinates.projectName,
        component_name: coordinates.componentName,
        environment: coordinates.environment,
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
      throw new NotFoundError('GitOps target configuration was not found');
    }
  }

  async bootstrapTargetMappings(mappings: GitOpsTargetInput[]): Promise<void> {
    for (const mapping of mappings) {
      validateGitOpsTargetInput(mapping);
    }

    if (mappings.length === 0) {
      return;
    }

    await this.knex(GITOPS_TARGETS_TABLE)
      .insert(
        mappings.map(mapping => ({
          ...this.toRow(mapping, this.knex.fn.now()),
          ownership: 'GITOPS_MANAGED',
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

  private toRow(input: GitOpsTargetInput, now: unknown) {
    return {
      namespace_name: input.namespaceName.trim(),
      project_name: input.projectName.trim(),
      component_name: input.componentName.trim(),
      environment: input.environment.trim(),
      repository_provider: input.repositoryProvider?.trim() ?? 'github',
      repository_owner: input.repositoryOwner.trim(),
      repository_name: input.repositoryName.trim(),
      base_branch: input.baseBranch.trim(),
      manifest_path: input.manifestPath.trim(),
      updated_at: now,
    };
  }

  async findTarget(
    coordinates: GitOpsTargetCoordinates,
  ): Promise<GitOpsTargetConfig | null> {
    const row = await this.knex<GitOpsTargetRow>(GITOPS_TARGETS_TABLE)
      .where({
        namespace_name: coordinates.namespaceName,
        project_name: coordinates.projectName,
        component_name: coordinates.componentName,
        environment: coordinates.environment,
      })
      .first();

    if (
      !row ||
      !row.repository_owner ||
      !row.repository_name ||
      !row.base_branch ||
      !row.manifest_path
    ) {
      return null;
    }

    const repositoryOwner = row.repository_owner;
    const repositoryName = row.repository_name;

    return {
      namespaceName: row.namespace_name,
      projectName: row.project_name,
      componentName: row.component_name,
      environment: row.environment,
      repositoryProvider: row.repository_provider ?? 'github',
      repositoryOwner,
      repositoryName,
      repository: `${repositoryOwner}/${repositoryName}`,
      baseBranch: row.base_branch,
      manifestPath: row.manifest_path,
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : new Date(row.updated_at).toISOString(),
    };
  }

  async getTarget(
    coordinates: GitOpsTargetCoordinates,
  ): Promise<GitOpsTargetConfig> {
    const target = await this.findTarget(coordinates);
    if (!target) {
      throw new NotFoundError(
        `GitOps target is not configured for ${coordinates.namespaceName}/${coordinates.projectName}/${coordinates.componentName} in ${coordinates.environment}. Please contact your platform administrator.`,
      );
    }
    return target;
  }
}
