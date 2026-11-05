import { mockServices, TestDatabases } from '@backstage/backend-test-utils';
import type { DatabaseService } from '@backstage/backend-plugin-api';
import { ConfigReader } from '@backstage/config';
import {
  applyGitOpsTargetMigrations,
  GitOpsTargetConfigurationService,
  readGitOpsTargetBootstrapMappings,
  type GitOpsTargetInput,
} from './GitOpsTargetConfigurationService';
import {
  applyGitOpsOwnershipMigrations,
  GitOpsOwnershipService,
  type GitOpsOwnershipInput,
} from './GitOpsOwnershipService';

const databases = TestDatabases.create({ ids: ['SQLITE_3'] });
const logger = mockServices.logger.mock();

describe('GitOpsTargetConfigurationService', () => {
  let knex: Awaited<ReturnType<DatabaseService['getClient']>>;
  let service: GitOpsTargetConfigurationService;

  const validTarget: GitOpsTargetInput = {
    namespaceName: 'default',
    projectName: 'payments',
    componentName: 'checkout',
    environment: 'staging',
    repositoryProvider: 'github',
    repositoryOwner: 'example',
    repositoryName: 'gitops',
    baseBranch: 'main',
    manifestPath:
      'projects/payments/components/checkout/release-bindings/checkout-staging.yaml',
  };

  beforeEach(async () => {
    knex = await databases.init('SQLITE_3');
    await applyGitOpsTargetMigrations(knex, logger);
    service = new GitOpsTargetConfigurationService(knex);
  });

  afterEach(async () => {
    await knex.destroy();
  });

  it('throws NotFoundError for unconfigured targets without returning ownership classification', async () => {
    await expect(
      service.getTarget({
        namespaceName: 'default',
        projectName: 'unmapped',
        componentName: 'component',
        environment: 'dev',
      }),
    ).rejects.toThrow(/GitOps target is not configured for/i);

    await expect(
      service.findTarget({
        namespaceName: 'default',
        projectName: 'unmapped',
        componentName: 'component',
        environment: 'dev',
      }),
    ).resolves.toBeNull();
  });

  it('creates and resolves a valid target configuration', async () => {
    const created = await service.createTarget(validTarget);
    expect(created).toMatchObject({
      namespaceName: 'default',
      projectName: 'payments',
      componentName: 'checkout',
      environment: 'staging',
      repositoryProvider: 'github',
      repositoryOwner: 'example',
      repositoryName: 'gitops',
      repository: 'example/gitops',
      baseBranch: 'main',
      manifestPath:
        'projects/payments/components/checkout/release-bindings/checkout-staging.yaml',
    });
    // Ensure ownership classification property is not present in target config
    expect((created as any).ownership).toBeUndefined();

    const fetched = await service.getTarget(validTarget);
    expect(fetched).toMatchObject({
      repository: 'example/gitops',
      baseBranch: 'main',
      manifestPath:
        'projects/payments/components/checkout/release-bindings/checkout-staging.yaml',
    });
  });

  it('rejects duplicate target creation', async () => {
    await service.createTarget(validTarget);
    await expect(service.createTarget(validTarget)).rejects.toThrow(
      'GitOps target configuration already exists',
    );
  });

  it('updates an existing target configuration and survives service recreation', async () => {
    await service.createTarget(validTarget);

    const updated = await service.updateTarget({
      ...validTarget,
      baseBranch: 'release-2026',
      manifestPath: 'manifests/checkout-staging.yaml',
    });
    expect(updated.baseBranch).toBe('release-2026');
    expect(updated.manifestPath).toBe('manifests/checkout-staging.yaml');

    const restartedService = new GitOpsTargetConfigurationService(knex);
    const fetched = await restartedService.getTarget(validTarget);
    expect(fetched.baseBranch).toBe('release-2026');
    expect(fetched.manifestPath).toBe('manifests/checkout-staging.yaml');
  });

  it('deletes target configuration and subsequent getTarget throws NotFoundError', async () => {
    await service.createTarget(validTarget);
    await service.deleteTarget(validTarget);

    await expect(service.getTarget(validTarget)).rejects.toThrow(
      /GitOps target is not configured/i,
    );
  });

  it('validates repository metadata and relative manifestPath', async () => {
    await expect(
      service.createTarget({
        ...validTarget,
        repositoryName: '',
      }),
    ).rejects.toThrow(/GitOps target requires repositoryOwner/i);

    await expect(
      service.createTarget({
        ...validTarget,
        manifestPath: '/absolute/path/manifest.yaml',
      }),
    ).rejects.toThrow(/manifestPath must be a repository-relative path/i);

    await expect(
      service.createTarget({
        ...validTarget,
        manifestPath: 'folder/../manifest.yaml',
      }),
    ).rejects.toThrow(/manifestPath must be a repository-relative path/i);
  });

  it('bootstraps target mappings without overwriting runtime updates', async () => {
    const config = new ConfigReader({
      bootstrapMappings: [
        {
          namespaceName: 'default',
          projectName: 'payments',
          componentName: 'checkout',
          environment: 'staging',
          repositoryProvider: 'github',
          repositoryOwner: 'example',
          repositoryName: 'gitops',
          baseBranch: 'main',
          manifestPath:
            'projects/payments/components/checkout/release-bindings/checkout-staging.yaml',
        },
      ],
    });

    const bootstrapList = readGitOpsTargetBootstrapMappings(config);
    expect(bootstrapList).toHaveLength(1);
    await service.bootstrapTargetMappings(bootstrapList);

    await service.updateTarget({
      ...validTarget,
      baseBranch: 'runtime-branch',
    });

    // Re-run bootstrap (e.g. backend restart)
    const restarted = new GitOpsTargetConfigurationService(knex);
    await restarted.bootstrapTargetMappings(bootstrapList);

    const target = await restarted.getTarget(validTarget);
    expect(target.baseBranch).toBe('runtime-branch');
  });

  it('preserves existing database data from GitOpsOwnershipService without data loss', async () => {
    // 1. Write data using GitOpsOwnershipService
    const ownershipService = new GitOpsOwnershipService(knex);
    const existingRow: GitOpsOwnershipInput = {
      namespaceName: 'prod-ns',
      projectName: 'billing',
      componentName: 'invoice-worker',
      environment: 'production',
      ownership: 'GITOPS_MANAGED',
      repositoryProvider: 'github',
      repositoryOwner: 'acme-corp',
      repositoryName: 'choreo-gitops',
      baseBranch: 'production',
      manifestPath: 'billing/invoice-worker-production.yaml',
    };
    await ownershipService.createOwnership(existingRow);

    // 2. TargetConfigurationService can seamlessly read the existing repository metadata
    const target = await service.getTarget({
      namespaceName: 'prod-ns',
      projectName: 'billing',
      componentName: 'invoice-worker',
      environment: 'production',
    });

    expect(target).toMatchObject({
      namespaceName: 'prod-ns',
      projectName: 'billing',
      componentName: 'invoice-worker',
      environment: 'production',
      repositoryOwner: 'acme-corp',
      repositoryName: 'choreo-gitops',
      repository: 'acme-corp/choreo-gitops',
      baseBranch: 'production',
      manifestPath: 'billing/invoice-worker-production.yaml',
    });

    // 3. Ownership service still reads it with ownership intact for backwards compatibility
    const ownership = await ownershipService.getOwnership({
      namespaceName: 'prod-ns',
      projectName: 'billing',
      componentName: 'invoice-worker',
      environment: 'production',
    });
    expect(ownership.ownership).toBe('GITOPS_MANAGED');
  });
});
