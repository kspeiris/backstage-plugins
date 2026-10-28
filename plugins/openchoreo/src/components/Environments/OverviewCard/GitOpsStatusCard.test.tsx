import { fireEvent, render, screen } from '@testing-library/react';
import { TestApiProvider } from '@backstage/test-utils';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import { MemoryRouter } from 'react-router-dom';
import { mockComponentEntity } from '@openchoreo/test-utils';
import {
  openChoreoClientApiRef,
  type OpenChoreoClientApi,
} from '../../../api/OpenChoreoClientApi';
import { GitOpsStatusCard } from './GitOpsStatusCard';

let mockGitOpsEnabled = true;
const mockUseOpenChoreoQuery = jest.fn();

jest.mock('@openchoreo/backstage-plugin-react', () => ({
  formatRelativeTime: (value: string) => `relative-${value}`,
  useOpenChoreoFeatures: () => ({
    gitops: { enabled: mockGitOpsEnabled },
  }),
  useOpenChoreoQuery: (...args: unknown[]) => mockUseOpenChoreoQuery(...args),
}));

jest.mock('@openchoreo/backstage-design-system', () => ({
  ...jest.requireActual('@openchoreo/backstage-design-system'),
  Card: ({
    children,
    ...props
  }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div data-testid="ds-card" {...props}>
      {children}
    </div>
  ),
}));

jest.mock('@backstage/core-components', () => ({
  Link: ({
    children,
    to,
    ...props
  }: React.PropsWithChildren<{ to: string }>) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const entity = mockComponentEntity({
  name: 'checkout',
  annotations: {
    'openchoreo.io/project': 'commerce',
    'openchoreo.io/component': 'checkout',
  },
});

function renderCard(client: Partial<OpenChoreoClientApi> = {}) {
  return render(
    <MemoryRouter>
      <EntityProvider entity={entity}>
        <TestApiProvider
          apis={[[openChoreoClientApiRef, client as OpenChoreoClientApi]]}
        >
          <GitOpsStatusCard />
        </TestApiProvider>
      </EntityProvider>
    </MemoryRouter>,
  );
}

describe('GitOpsStatusCard', () => {
  beforeEach(() => {
    mockGitOpsEnabled = true;
    mockUseOpenChoreoQuery.mockReset();
    mockUseOpenChoreoQuery.mockReturnValue({
      data: undefined,
      loading: false,
      isRefetching: false,
      error: null,
      refetch: jest.fn(),
    });
  });

  it('fetches all deployment environments and shows statuses, latest PR, and details', async () => {
    const fetchEnvironmentInfo = jest.fn().mockResolvedValue([
      { name: 'Development', resourceName: 'development' },
      { name: 'Staging', resourceName: 'staging' },
      { name: 'Production', resourceName: 'production' },
    ]);
    const statuses = [
      {
        environment: 'development',
        pullRequest: {
          state: 'MERGED',
          number: 12,
          promotedAt: '2026-10-25T00:00:00Z',
        },
        deployment: { state: 'READY' },
      },
      {
        environment: 'staging',
        pullRequest: {
          state: 'OPEN',
          number: 14,
          url: 'https://github.com/acme/checkout/pull/14',
          promotedAt: '2026-10-26T00:00:00Z',
        },
        deployment: { state: 'DEPLOYING' },
        lastCheckedAt: '2026-10-27T00:00:00Z',
      },
      {
        environment: 'production',
        pullRequest: { state: 'NOT_CREATED' },
        deployment: { state: 'NOT_STARTED' },
      },
    ];
    const fetchGitOpsChangeStatus = jest
      .fn()
      .mockResolvedValueOnce({
        ...statuses[0],
      })
      .mockResolvedValueOnce(statuses[1])
      .mockResolvedValueOnce(statuses[2]);

    mockUseOpenChoreoQuery.mockImplementation(
      (_key: unknown, fetcher: () => Promise<unknown>) => ({
        data: [
          { key: 'development', status: statuses[0] },
          { key: 'staging', status: statuses[1] },
          { key: 'production', status: statuses[2] },
        ],
        loading: false,
        isRefetching: false,
        error: null,
        refetch: jest.fn(),
        fetcher,
      }),
    );

    renderCard({ fetchEnvironmentInfo, fetchGitOpsChangeStatus });

    const [, fetchStatuses, options] = mockUseOpenChoreoQuery.mock.calls[0];
    expect(options).toEqual({ enabled: true });
    await fetchStatuses();
    expect(fetchEnvironmentInfo).toHaveBeenCalledWith(entity);
    expect(fetchGitOpsChangeStatus.mock.calls.map(call => call[1])).toEqual([
      'development',
      'staging',
      'production',
    ]);

    expect(screen.getByText('Development')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Staging')).toBeInTheDocument();
    expect(screen.getByText('Deploying')).toBeInTheDocument();
    expect(screen.getByText('Production')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PR #14' })).toHaveAttribute(
      'href',
      'https://github.com/acme/checkout/pull/14',
    );
    expect(
      screen.getByText('Last updated: relative-2026-10-27T00:00:00Z'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View details' })).toHaveAttribute(
      'href',
      'environments',
    );
  });

  it('shows loading and API error states', () => {
    mockUseOpenChoreoQuery.mockReturnValue({
      data: undefined,
      loading: true,
      isRefetching: false,
      error: null,
      refetch: jest.fn(),
    });
    const { rerender } = renderCard();
    expect(screen.getAllByTestId('skeleton')).toHaveLength(3);

    mockUseOpenChoreoQuery.mockReturnValue({
      data: undefined,
      loading: false,
      isRefetching: false,
      error: new Error('Backend unavailable'),
      refetch: jest.fn(),
    });
    rerender(
      <MemoryRouter>
        <EntityProvider entity={entity}>
          <TestApiProvider
            apis={[[openChoreoClientApiRef, {} as OpenChoreoClientApi]]}
          >
            <GitOpsStatusCard />
          </TestApiProvider>
        </EntityProvider>
      </MemoryRouter>,
    );
    expect(
      screen.getByText('Failed to load GitOps status: Backend unavailable'),
    ).toBeInTheDocument();
  });

  it('does not render when GitOps is disabled', () => {
    mockGitOpsEnabled = false;
    renderCard();
    expect(screen.queryByTestId('ds-card')).not.toBeInTheDocument();
    expect(mockUseOpenChoreoQuery.mock.calls[0][2]).toEqual({
      enabled: false,
    });
  });

  it('refreshes status when refresh is clicked', () => {
    const refetch = jest.fn();
    mockUseOpenChoreoQuery.mockReturnValue({
      data: [],
      loading: false,
      isRefetching: false,
      error: null,
      refetch,
    });

    renderCard();
    fireEvent.click(screen.getByLabelText('Refresh GitOps status'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
