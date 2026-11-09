import { CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';
import type { FluxSyncState } from '@openchoreo/backstage-plugin-common';

export interface CustomObjectClient {
  getNamespacedCustomObject(input: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    name: string;
  }): Promise<unknown>;
}

interface FluxCondition {
  status?: string;
  reason?: string;
  message?: string;
}

export interface FluxStatus {
  state: FluxSyncState;
  sourceRevision?: string;
  appliedRevision?: string;
  statusReason?: string;
  statusMessage?: string;
}

export interface FluxStatusScope {
  namespaceName: string;
  projectName: string;
  componentName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRecord(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const record = value[key];
  return isRecord(record) ? record : undefined;
}

function getCondition(value: unknown, type: string): FluxCondition | undefined {
  const conditions = getRecord(value, 'status')?.conditions;
  if (!Array.isArray(conditions)) return undefined;

  const condition = conditions.find(
    item => isRecord(item) && item.type === type,
  );
  if (!isRecord(condition)) return undefined;
  return {
    status: typeof condition.status === 'string' ? condition.status : undefined,
    reason: typeof condition.reason === 'string' ? condition.reason : undefined,
    message:
      typeof condition.message === 'string' ? condition.message : undefined,
  };
}

function getRevision(value: unknown, key: string): string | undefined {
  const revision = getRecord(value, 'status')?.[key];
  return typeof revision === 'string' && revision.length > 0
    ? revision
    : undefined;
}

function getSourceRevision(value: unknown): string | undefined {
  const artifact = getRecord(value, 'status')?.artifact;
  if (!isRecord(artifact)) return undefined;
  return typeof artifact.revision === 'string' && artifact.revision.length > 0
    ? artifact.revision
    : undefined;
}

function isReconciling(value: unknown): boolean {
  return getCondition(value, 'Reconciling')?.status === 'True';
}

function observedGenerationIsStale(value: unknown): boolean {
  const metadataGeneration = getRecord(value, 'metadata')?.generation;
  const observedGeneration = getRecord(value, 'status')?.observedGeneration;
  return (
    typeof metadataGeneration === 'number' &&
    typeof observedGeneration === 'number' &&
    observedGeneration < metadataGeneration
  );
}

function makeDefaultClient(): CustomObjectClient {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromDefault();
  return kubeConfig.makeApiClient(CustomObjectsApi);
}

export class FluxStatusService {
  constructor(
    private readonly namespace: string,
    private readonly gitRepositoryName: string,
    private readonly kustomizationName: string,
    private readonly scope: FluxStatusScope,
    private readonly createClient: () => CustomObjectClient = makeDefaultClient,
  ) {}

  async getStatus(target: FluxStatusScope): Promise<FluxStatus | undefined> {
    if (
      target.namespaceName !== this.scope.namespaceName ||
      target.projectName !== this.scope.projectName ||
      target.componentName !== this.scope.componentName
    ) {
      return undefined;
    }

    const client = this.createClient();

    // Fetch GitRepository and Kustomization independently so a missing
    // Kustomization (404) does not mask the GitRepository status.
    let gitRepository: unknown;
    let gitRepoError: Error | undefined;
    try {
      gitRepository = await client.getNamespacedCustomObject({
        group: 'source.toolkit.fluxcd.io',
        version: 'v1',
        namespace: this.namespace,
        plural: 'gitrepositories',
        name: this.gitRepositoryName,
      });
    } catch (error) {
      gitRepoError = error instanceof Error ? error : new Error(String(error));
    }

    let kustomization: unknown;
    let kustomizationMissing = false;
    let kustomizationError: Error | undefined;
    try {
      kustomization = await client.getNamespacedCustomObject({
        group: 'kustomize.toolkit.fluxcd.io',
        version: 'v1',
        namespace: this.namespace,
        plural: 'kustomizations',
        name: this.kustomizationName,
      });
    } catch (error) {
      const err = error as { code?: number; statusCode?: number };
      if (err?.code === 404 || err?.statusCode === 404) {
        kustomizationMissing = true;
      } else {
        kustomizationError = error instanceof Error ? error : new Error(String(error));
      }
    }

    // GitRepository unavailable → cannot determine anything meaningful.
    if (gitRepoError) {
      return {
        state: 'UNKNOWN',
        statusReason: 'GitRepositoryUnavailable',
        statusMessage: `Could not read GitRepository '${this.gitRepositoryName}' in namespace '${this.namespace}'. ${gitRepoError.message}`,
      };
    }

    const sourceCondition = getCondition(gitRepository!, 'Ready');
    const sourceRevision = getSourceRevision(gitRepository!);

    // Kustomization not applied yet → report NOT_CONFIGURED.
    if (kustomizationMissing) {
      return {
        state: 'NOT_CONFIGURED',
        sourceRevision,
        statusReason: 'KustomizationNotFound',
        statusMessage: `Flux Kustomization '${this.kustomizationName}' has not been applied to namespace '${this.namespace}'. Reconciliation is not active.`,
      };
    }

    // Kustomization exists but another error occurred fetching it.
    if (kustomizationError) {
      return {
        state: 'UNKNOWN',
        statusReason: 'KustomizationUnavailable',
        statusMessage: `Could not read Kustomization '${this.kustomizationName}' in namespace '${this.namespace}'. ${kustomizationError.message}`,
      };
    }

    const readyCondition = getCondition(kustomization!, 'Ready');
    const appliedRevision = getRevision(kustomization!, 'lastAppliedRevision');
    const condition =
      sourceCondition?.status === 'False' ? sourceCondition : readyCondition;
    const statusReason = condition?.reason;
    const statusMessage = condition?.message;

    let state: FluxSyncState;
    if (sourceCondition?.status === 'False') {
      state = 'FAILED';
    } else if (readyCondition?.status === 'False') {
      state =
        readyCondition.reason === 'Progressing' ||
        readyCondition.reason === 'ReconciliationInProgress'
          ? 'RECONCILING'
          : 'FAILED';
    } else if (
      isReconciling(kustomization!) ||
      observedGenerationIsStale(kustomization!)
    ) {
      state = 'RECONCILING';
    } else if (
      readyCondition?.status === 'True' &&
      sourceRevision &&
      appliedRevision === sourceRevision
    ) {
      state = 'SYNCED';
    } else if (sourceRevision && sourceRevision !== appliedRevision) {
      state = 'OUT_OF_SYNC';
    } else {
      state = 'UNKNOWN';
    }

    return {
      state,
      sourceRevision,
      appliedRevision,
      statusReason,
      statusMessage,
    };
  }
}
