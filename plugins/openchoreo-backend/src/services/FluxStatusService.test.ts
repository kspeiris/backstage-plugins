import { FluxStatusService, type CustomObjectClient } from './FluxStatusService';

jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromDefault() {}
    makeApiClient() {
      return {};
    }
  },
  CustomObjectsApi: class {},
}));

function createFluxClient(source: unknown, kustomization: unknown) {
  return {
    getNamespacedCustomObject: jest.fn(
      ({ plural }: { plural: string }): Promise<unknown> =>
        Promise.resolve(plural === 'gitrepositories' ? source : kustomization),
    ),
  };
}

const readySource = {
  status: {
    artifact: { revision: 'main@sha1:abc123' },
    conditions: [{ type: 'Ready', status: 'True' }],
  },
};

const readyKustomization = {
  metadata: { generation: 1 },
  status: {
    observedGeneration: 1,
    lastAppliedRevision: 'main@sha1:abc123',
    conditions: [{ type: 'Ready', status: 'True' }],
  },
};

const target = {
  namespaceName: 'default',
  projectName: 'default',
  componentName: 'biocare-web',
};

describe('FluxStatusService', () => {
  it('reports synced when the applied and source revisions match', async () => {
    const client = createFluxClient(readySource, readyKustomization);
    const service = new FluxStatusService(
      'flux-system',
      'openchoreo-gitops',
      'openchoreo-gitops',
      target,
      () => client,
    );

    await expect(service.getStatus(target)).resolves.toEqual({
      state: 'SYNCED',
      sourceRevision: 'main@sha1:abc123',
      appliedRevision: 'main@sha1:abc123',
      statusReason: undefined,
      statusMessage: undefined,
    });
    expect(client.getNamespacedCustomObject).toHaveBeenCalledTimes(2);
  });

  it('reports out of sync when the source has advanced', async () => {
    const client = createFluxClient(readySource, {
      ...readyKustomization,
      status: {
        ...readyKustomization.status,
        lastAppliedRevision: 'main@sha1:older',
      },
    });
    const service = new FluxStatusService(
      'flux-system',
      'openchoreo-gitops',
      'openchoreo-gitops',
      target,
      () => client,
    );

    await expect(service.getStatus(target)).resolves.toMatchObject({
      state: 'OUT_OF_SYNC',
      sourceRevision: 'main@sha1:abc123',
      appliedRevision: 'main@sha1:older',
    });
  });

  it('reports a source reconciliation failure', async () => {
    const client = createFluxClient(
      {
        status: {
          conditions: [
            {
              type: 'Ready',
              status: 'False',
              reason: 'GitOperationFailed',
              message: 'Unable to fetch the repository.',
            },
          ],
        },
      },
      readyKustomization,
    );
    const service = new FluxStatusService(
      'flux-system',
      'openchoreo-gitops',
      'openchoreo-gitops',
      target,
      () => client,
    );

    await expect(service.getStatus(target)).resolves.toMatchObject({
      state: 'FAILED',
      statusReason: 'GitOperationFailed',
      statusMessage: 'Unable to fetch the repository.',
    });
  });

  it('reports a failed Kustomization build', async () => {
    const client = createFluxClient(readySource, {
      ...readyKustomization,
      status: {
        ...readyKustomization.status,
        conditions: [
          {
            type: 'Ready',
            status: 'False',
            reason: 'BuildFailed',
            message: 'The Kustomize build failed.',
          },
        ],
      },
    });
    const service = new FluxStatusService(
      'flux-system',
      'openchoreo-gitops',
      'openchoreo-gitops',
      target,
      () => client,
    );

    await expect(service.getStatus(target)).resolves.toMatchObject({
      state: 'FAILED',
      statusReason: 'BuildFailed',
      statusMessage: 'The Kustomize build failed.',
    });
  });

  it('reports reconciling while the Kustomization is actively progressing', async () => {
    const client = createFluxClient(readySource, {
      ...readyKustomization,
      status: {
        ...readyKustomization.status,
        conditions: [
          { type: 'Ready', status: 'False', reason: 'Progressing' },
          { type: 'Reconciling', status: 'True' },
        ],
      },
    });
    const service = new FluxStatusService(
      'flux-system',
      'openchoreo-gitops',
      'openchoreo-gitops',
      target,
      () => client,
    );

    await expect(service.getStatus(target)).resolves.toMatchObject({
      state: 'RECONCILING',
    });
  });

  it('does not report this Kustomization for an unrelated component', async () => {
    const client = createFluxClient(readySource, readyKustomization);
    const service = new FluxStatusService(
      'flux-system',
      'openchoreo-gitops',
      'openchoreo-gitops',
      target,
      () => client,
    );

    await expect(
      service.getStatus({ ...target, componentName: 'another-component' }),
    ).resolves.toBeUndefined();
    expect(client.getNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('reports NOT_CONFIGURED when the Kustomization has not been applied', async () => {
    const notFoundError = { code: 404, statusCode: 404 };
    const client = {
      getNamespacedCustomObject: jest.fn(
        (input: { plural: string }): Promise<unknown> =>
          input.plural === 'gitrepositories'
            ? Promise.resolve(readySource)
            : Promise.reject(notFoundError),
      ),
    };
    const service = new FluxStatusService(
      'flux-system',
      'openchoreo-gitops',
      'openchoreo-gitops',
      target,
      () => client as unknown as CustomObjectClient,
    );

    await expect(service.getStatus(target)).resolves.toMatchObject({
      state: 'NOT_CONFIGURED',
      sourceRevision: 'main@sha1:abc123',
      statusReason: 'KustomizationNotFound',
    });
  });

  it('reports UNKNOWN when the GitRepository cannot be read', async () => {
    const client = {
      getNamespacedCustomObject: jest.fn(
        (_input: { plural: string }): Promise<unknown> =>
          Promise.reject(new Error('connection refused')),
      ),
    };
    const service = new FluxStatusService(
      'flux-system',
      'openchoreo-gitops',
      'openchoreo-gitops',
      target,
      () => client as unknown as CustomObjectClient,
    );

    await expect(service.getStatus(target)).resolves.toMatchObject({
      state: 'UNKNOWN',
      statusReason: 'GitRepositoryUnavailable',
    });
  });
});
