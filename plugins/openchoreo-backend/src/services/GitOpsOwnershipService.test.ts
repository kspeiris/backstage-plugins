import { mockServices, TestDatabases } from '@backstage/backend-test-utils';
import type { DatabaseService } from '@backstage/backend-plugin-api';
import { ConfigReader } from '@backstage/config';
import {
  applyGitOpsOwnershipMigrations,
  GitOpsOwnershipService,
  readGitOpsOwnershipBootstrapMappings,
  type GitOpsOwnershipInput,
} from './GitOpsOwnershipService';
import {
  createGitOpsAdminAuthorizationService,
  GitOpsAdminAuthorizationService,
} from './GitOpsAdminAuthorizationService';

const databases = TestDatabases.create({ ids: ['SQLITE_3'] });
const logger = mockServices.logger.mock();

describe('GitOpsOwnershipService', () => {
  let knex: Awaited<ReturnType<DatabaseService['getClient']>>;
  let service: GitOpsOwnershipService;

  const bootstrapMapping: GitOpsOwnershipInput = {
    namespaceName: 'default',
    projectName: 'payments',
    componentName: 'checkout',
    environment: 'staging',
    ownership: 'GITOPS_MANAGED',
    repositoryProvider: 'github',
    repositoryOwner: 'example',
    repositoryName: 'gitops',
    baseBranch: 'main',
    manifestPath:
      'projects/payments/components/checkout/release-bindings/checkout-staging.yaml',
  };

  beforeEach(async () => {
    knex = await databases.init('SQLITE_3');
    await applyGitOpsOwnershipMigrations(knex, logger);
    service = new GitOpsOwnershipService(knex);
  });

  afterEach(async () => {
    await knex.destroy();
  });

  it('returns UNKNOWN for unmapped resources', async () => {
    await expect(
      service.getOwnership({
        namespaceName: 'default',
        projectName: 'unmapped',
        componentName: 'component',
        environment: 'dev',
      }),
    ).resolves.toMatchObject({
      ownership: 'UNKNOWN',
      repositoryConfigured: false,
    });
  });

  it('bootstraps mappings once and does not overwrite runtime updates or deletes after restart', async () => {
    const config = new ConfigReader({
      bootstrapMappings: [bootstrapMapping],
    });
    const mappings = readGitOpsOwnershipBootstrapMappings(config);
    await service.bootstrapOwnershipMappings(mappings);
    const restartedService = new GitOpsOwnershipService(knex);

    await restartedService.updateOwnership({
      ...bootstrapMapping,
      ownership: 'API_MANAGED',
      repositoryOwner: undefined,
      repositoryName: undefined,
      baseBranch: undefined,
      manifestPath: undefined,
    });
    await restartedService.bootstrapOwnershipMappings(mappings);
    await expect(
      restartedService.getOwnership(bootstrapMapping),
    ).resolves.toMatchObject({
      ownership: 'API_MANAGED',
      repositoryConfigured: false,
    });

    await restartedService.deleteOwnership(bootstrapMapping);
    await restartedService.bootstrapOwnershipMappings(mappings);
    await expect(
      restartedService.getOwnership(bootstrapMapping),
    ).resolves.toMatchObject({
      ownership: 'UNKNOWN',
      repositoryConfigured: false,
    });
  });

  it('creates mappings without allowing duplicate create requests to overwrite records', async () => {
    await service.createOwnership(bootstrapMapping);

    await expect(
      service.createOwnership({
        ...bootstrapMapping,
        ownership: 'API_MANAGED',
        repositoryOwner: undefined,
        repositoryName: undefined,
        baseBranch: undefined,
        manifestPath: undefined,
      }),
    ).rejects.toThrow('Ownership mapping already exists');

    await expect(service.getOwnership(bootstrapMapping)).resolves.toMatchObject(
      {
        ownership: 'GITOPS_MANAGED',
        repository: 'example/gitops',
      },
    );
  });

  it('requires repository metadata for GitOps-managed ownership', async () => {
    await expect(
      service.bootstrapOwnershipMappings([
        {
          ...bootstrapMapping,
          repositoryName: undefined,
        },
      ]),
    ).rejects.toThrow(/GITOPS_MANAGED ownership requires/i);
  });
});

describe('GitOpsAdminAuthorizationService', () => {
  const adminAuthorization = createGitOpsAdminAuthorizationService(
    new ConfigReader({
      admins: {
        users: ['user:default/admin@example.com'],
        groups: ['group:default/platform-admins'],
      },
    }),
  );

  it('recognizes configured users and group ownership references', () => {
    expect(
      adminAuthorization.isAdmin({
        userEntityRef: 'user:default/admin@example.com',
      }),
    ).toBe(true);
    expect(
      adminAuthorization.isAdmin({
        userEntityRef: 'user:default/developer@example.com',
        ownershipEntityRefs: ['group:default/platform-admins'],
      }),
    ).toBe(true);
  });

  it('rejects users not configured as administrators', () => {
    expect(
      adminAuthorization.isAdmin({
        userEntityRef: 'user:default/developer@example.com',
        ownershipEntityRefs: ['user:default/developer@example.com'],
      }),
    ).toBe(false);
    expect(() =>
      adminAuthorization.assertAdmin({
        userEntityRef: 'user:default/developer@example.com',
      }),
    ).toThrow(/only configured GitOps administrators/i);
  });

  it('rejects malformed or wrong-kind admin entity references', () => {
    expect(
      () => new GitOpsAdminAuthorizationService(['group:default/team'], []),
    ).toThrow(/fully qualified user entity references/i);
  });
});
