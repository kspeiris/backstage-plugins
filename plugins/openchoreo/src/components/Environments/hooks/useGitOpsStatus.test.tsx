import { TestApiProvider } from '@backstage/test-utils';
import { renderHook, waitFor } from '@testing-library/react';
import type { Entity } from '@backstage/catalog-model';
import {
  openChoreoClientApiRef,
  type OpenChoreoClientApi,
} from '../../../api/OpenChoreoClientApi';
import { useGitOpsStatus } from './useGitOpsStatus';

let mockGitOpsEnabled = true;
const mockUseOpenChoreoQuery = jest.fn();

jest.mock('@openchoreo/backstage-plugin-react', () => ({
  useOpenChoreoFeatures: () => ({
    gitops: { enabled: mockGitOpsEnabled },
  }),
  useOpenChoreoQuery: (...args: unknown[]) => mockUseOpenChoreoQuery(...args),
}));

const entity: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'checkout',
    namespace: 'default',
    annotations: {
      'openchoreo.io/component': 'checkout',
      'openchoreo.io/project': 'commerce',
      'openchoreo.io/namespace': 'production',
    },
  },
  spec: { type: 'service' },
};

describe('useGitOpsStatus', () => {
  const refetch = jest.fn();

  beforeEach(() => {
    mockGitOpsEnabled = true;
    mockUseOpenChoreoQuery.mockReset();
    refetch.mockReset();
    mockUseOpenChoreoQuery.mockReturnValue({
      data: undefined,
      loading: false,
      isRefetching: false,
      error: null,
      refetch,
    });
  });

  it('uses the entity/environment query and client fetcher', async () => {
    const status = {
      componentName: 'checkout',
      environment: 'staging',
      pullRequest: { state: 'OPEN' },
      deployment: { state: 'NOT_STARTED' },
    };
    const fetchGitOpsChangeStatus = jest.fn().mockResolvedValue(status);
    const { result } = renderHook(
      () => useGitOpsStatus({ entity, environment: 'staging' }),
      {
        wrapper: ({ children }) => (
          <TestApiProvider
            apis={[
              [
                openChoreoClientApiRef,
                { fetchGitOpsChangeStatus } as OpenChoreoClientApi,
              ],
            ]}
          >
            {children}
          </TestApiProvider>
        ),
      },
    );

    expect(result.current.enabled).toBe(true);
    const [queryKey, fetcher, options] = mockUseOpenChoreoQuery.mock.calls[0];
    expect(queryKey).toEqual([
      'gitops-change-status',
      'component:default/checkout',
      'staging',
    ]);
    expect(options).toEqual({ enabled: true });
    await expect(fetcher()).resolves.toEqual(status);
    expect(fetchGitOpsChangeStatus).toHaveBeenCalledWith(entity, 'staging');
  });

  it('refetches when the parent environment refresh key changes', async () => {
    const { rerender } = renderHook(
      ({ refreshKey }) =>
        useGitOpsStatus({
          entity,
          environment: 'staging',
          refreshKey,
        }),
      {
        initialProps: { refreshKey: 0 },
        wrapper: ({ children }) => (
          <TestApiProvider
            apis={[[openChoreoClientApiRef, {} as OpenChoreoClientApi]]}
          >
            {children}
          </TestApiProvider>
        ),
      },
    );

    rerender({ refreshKey: 1 });
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
  });

  it('does not refetch when the feature is disabled', async () => {
    mockGitOpsEnabled = false;
    const { result, rerender } = renderHook(
      ({ refreshKey }) =>
        useGitOpsStatus({
          entity,
          environment: 'staging',
          refreshKey,
        }),
      {
        initialProps: { refreshKey: 0 },
        wrapper: ({ children }) => (
          <TestApiProvider
            apis={[[openChoreoClientApiRef, {} as OpenChoreoClientApi]]}
          >
            {children}
          </TestApiProvider>
        ),
      },
    );

    expect(result.current.enabled).toBe(false);
    rerender({ refreshKey: 1 });
    await waitFor(() => expect(refetch).not.toHaveBeenCalled());
  });
});
