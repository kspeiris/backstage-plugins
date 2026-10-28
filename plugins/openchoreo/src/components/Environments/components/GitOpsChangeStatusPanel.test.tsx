import { fireEvent, render, screen } from '@testing-library/react';
import { TestApiProvider } from '@backstage/test-utils';
import type { Entity } from '@backstage/catalog-model';
import {
  openChoreoClientApiRef,
  type OpenChoreoClientApi,
} from '../../../api/OpenChoreoClientApi';
import { GitOpsChangeStatusPanel } from './GitOpsChangeStatusPanel';

let mockGitOpsEnabled = true;
const mockUseOpenChoreoQuery = jest.fn();

jest.mock('@openchoreo/backstage-plugin-react', () => ({
  formatRelativeTime: (value: string) => `relative-${value}`,
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

const status = {
  componentName: 'checkout',
  environment: 'prod',
  pullRequest: {
    number: 42,
    url: 'https://github.com/acme/commerce/pull/42',
    state: 'MERGED' as const,
    mergeCommitSha: 'abc123',
    isStale: false,
  },
  deployment: {
    state: 'SYNC_PENDING' as const,
    bindingReady: false,
    statusReason: 'WaitingForSync',
    statusMessage: 'Waiting for the merged revision to reach the environment.',
  },
  lastCheckedAt: '2025-01-01T00:00:00.000Z',
};

function renderPanel(client: { fetchGitOpsChangeStatus: jest.Mock }) {
  return render(
    <TestApiProvider
      apis={[[openChoreoClientApiRef, client as OpenChoreoClientApi]]}
    >
      <GitOpsChangeStatusPanel entity={entity} environment="prod" />
    </TestApiProvider>,
  );
}

describe('GitOpsChangeStatusPanel', () => {
  beforeEach(() => {
    mockGitOpsEnabled = true;
    mockUseOpenChoreoQuery.mockReset();
    mockUseOpenChoreoQuery.mockReturnValue({
      data: status,
      loading: false,
      isRefetching: false,
      error: null,
      refetch: jest.fn(),
    });
  });

  it('shows PR and deployment states, diagnostics, and last checked time', () => {
    const client = { fetchGitOpsChangeStatus: jest.fn() };
    renderPanel(client);

    expect(screen.getByText('Pull request')).toBeInTheDocument();
    expect(screen.getByText('Merged')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PR #42' })).toHaveAttribute(
      'href',
      status.pullRequest.url,
    );
    expect(screen.getByText('Deployment')).toBeInTheDocument();
    expect(screen.getByText('Sync Pending')).toBeInTheDocument();
    expect(screen.getByText('Reason: WaitingForSync')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Waiting for the merged revision to reach the environment.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Merged revision: abc123')).toBeInTheDocument();
    expect(
      screen.getByText('Checked relative-2025-01-01T00:00:00.000Z'),
    ).toBeInTheDocument();
    expect(mockUseOpenChoreoQuery.mock.calls[0][2]).toEqual({
      enabled: true,
    });
  });

  it('refreshes status when the GitOps refresh button is clicked', () => {
    const refetch = jest.fn();
    mockUseOpenChoreoQuery.mockReturnValue({
      data: status,
      loading: false,
      isRefetching: false,
      error: null,
      refetch,
    });

    renderPanel({ fetchGitOpsChangeStatus: jest.fn() });
    fireEvent.click(screen.getByLabelText('Refresh GitOps status'));

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows query errors and allows retrying', () => {
    const refetch = jest.fn();
    mockUseOpenChoreoQuery.mockReturnValue({
      data: undefined,
      loading: false,
      isRefetching: false,
      error: new Error('Backend failed with token=private-value'),
      refetch,
    });

    renderPanel({ fetchGitOpsChangeStatus: jest.fn() });

    expect(
      screen.getByText('Unable to load GitOps status. Refresh to try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/private-value/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Retry GitOps status'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows a deployment failure as an error with the backend diagnostic', () => {
    const refetch = jest.fn();
    mockUseOpenChoreoQuery.mockReturnValue({
      data: {
        ...status,
        deployment: {
          ...status.deployment,
          state: 'FAILED',
          statusReason: 'ImagePullBackOff',
          statusMessage: 'The container image could not be pulled.',
        },
        diagnostics: [
          {
            source: 'OpenChoreo',
            reason: 'ImagePullBackOff',
            message: 'The container image could not be pulled.',
            lastCheckedAt: '2025-01-01T00:00:00.000Z',
          },
        ],
      },
      loading: false,
      isRefetching: false,
      error: null,
      refetch,
    });

    renderPanel({ fetchGitOpsChangeStatus: jest.fn() });

    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Source: OpenChoreo')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The container image could not be pulled.',
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Deployment Status: Failed',
    );
    expect(
      screen.getByText('Last checked: relative-2025-01-01T00:00:00.000Z'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('hides the successful Ready condition diagnostic', () => {
    mockUseOpenChoreoQuery.mockReturnValue({
      data: {
        ...status,
        deployment: {
          state: 'READY',
          bindingReady: true,
          statusReason: 'Ready',
          statusMessage: 'ReleaseBinding is ready',
        },
      },
      loading: false,
      isRefetching: false,
      error: null,
      refetch: jest.fn(),
    });

    renderPanel({ fetchGitOpsChangeStatus: jest.fn() });

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText('Reason: Ready')).not.toBeInTheDocument();
    expect(
      screen.queryByText('ReleaseBinding is ready'),
    ).not.toBeInTheDocument();
  });

  it('does not render GitOps status when the feature is disabled', () => {
    mockGitOpsEnabled = false;
    const client = { fetchGitOpsChangeStatus: jest.fn() };

    renderPanel(client);

    expect(
      screen.queryByLabelText('GitOps change status'),
    ).not.toBeInTheDocument();
    expect(mockUseOpenChoreoQuery.mock.calls[0][2]).toEqual({
      enabled: false,
    });
  });

  it('marks a last-known pull request state as stale', () => {
    mockUseOpenChoreoQuery.mockReturnValue({
      data: {
        ...status,
        pullRequest: { ...status.pullRequest, isStale: true },
        diagnostics: [
          {
            source: 'GitHub',
            reason: 'PullRequestStatusStale',
            message:
              'GitHub could not be reached. The pull request state shown is the last known state.',
            lastCheckedAt: '2025-01-01T00:00:00.000Z',
          },
        ],
      },
      loading: false,
      isRefetching: false,
      error: null,
      refetch: jest.fn(),
    });

    renderPanel({ fetchGitOpsChangeStatus: jest.fn() });

    expect(screen.getByText('Stale')).toBeInTheDocument();
    expect(screen.getByText('Source: GitHub')).toBeInTheDocument();
    expect(screen.getByText('Pull Request Status: Merged')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'View Pull Request' }),
    ).toHaveAttribute('href', status.pullRequest.url);
  });
});
