import { useEffect, useRef } from 'react';
import { stringifyEntityRef, type Entity } from '@backstage/catalog-model';
import { useApi } from '@backstage/core-plugin-api';
import {
  useOpenChoreoFeatures,
  useOpenChoreoQuery,
} from '@openchoreo/backstage-plugin-react';
import type { GitOpsChangeStatus } from '@openchoreo/backstage-plugin-common';
import { openChoreoClientApiRef } from '../../../api/OpenChoreoClientApi';

export interface UseGitOpsStatusOptions {
  entity: Entity;
  environment: string;
  refreshKey?: number;
}

/**
 * Loads GitOps PR and deployment status for one component environment.
 * The optional refresh key lets a containing environment panel refresh this
 * status alongside its own data without coupling the two query implementations.
 */
export function useGitOpsStatus({
  entity,
  environment,
  refreshKey,
}: UseGitOpsStatusOptions) {
  const client = useApi(openChoreoClientApiRef);
  const features = useOpenChoreoFeatures();
  const query = useOpenChoreoQuery<GitOpsChangeStatus>(
    ['gitops-change-status', stringifyEntityRef(entity), environment],
    () => client.fetchGitOpsChangeStatus(entity, environment),
    { enabled: features.gitops.enabled },
  );
  const lastRefreshKey = useRef(refreshKey);

  useEffect(() => {
    if (
      !features.gitops.enabled ||
      refreshKey === undefined ||
      lastRefreshKey.current === refreshKey
    ) {
      return;
    }

    lastRefreshKey.current = refreshKey;
    void query.refetch();
  }, [features.gitops.enabled, query.refetch, refreshKey]);

  return {
    ...query,
    enabled: features.gitops.enabled,
  };
}
