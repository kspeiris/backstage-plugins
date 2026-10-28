import { useMemo } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Link as MaterialLink,
  Tooltip,
  Typography,
} from '@material-ui/core';
import { makeStyles } from '@material-ui/core/styles';
import RefreshIcon from '@material-ui/icons/Refresh';
import Alert from '@material-ui/lab/Alert';
import { Link } from '@backstage/core-components';
import { useEntity } from '@backstage/plugin-catalog-react';
import { Card, Skeleton } from '@openchoreo/backstage-design-system';
import {
  formatRelativeTime,
  useOpenChoreoFeatures,
  useOpenChoreoQuery,
} from '@openchoreo/backstage-plugin-react';
import type {
  DeploymentState,
  GitOpsChangeStatus,
} from '@openchoreo/backstage-plugin-common';
import { useApi } from '@backstage/core-plugin-api';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { openChoreoClientApiRef } from '../../../api/OpenChoreoClientApi';
import type { Environment } from '../hooks/useEnvironmentData';

const ENVIRONMENTS = [
  { key: 'development', label: 'Development' },
  { key: 'staging', label: 'Staging' },
  { key: 'production', label: 'Production' },
] as const;

const useStyles = makeStyles(theme => ({
  card: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    borderRadius: '12px !important',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: theme.spacing(1.5),
  },
  title: {
    fontWeight: 600,
    fontSize: theme.typography.h6.fontSize,
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1.25),
    flex: 1,
  },
  environmentRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing(1),
  },
  environmentName: {
    color: theme.palette.text.secondary,
  },
  ready: {
    backgroundColor: theme.palette.success.light,
    color: theme.palette.success.dark,
  },
  warning: {
    backgroundColor: theme.palette.warning.light,
    color: theme.palette.warning.dark,
  },
  failed: {
    backgroundColor: theme.palette.error.light,
    color: theme.palette.error.dark,
  },
  actions: {
    marginTop: 'auto',
    paddingTop: theme.spacing(1.5),
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
}));

type EnvironmentStatus = {
  key: (typeof ENVIRONMENTS)[number]['key'];
  label: string;
  status?: GitOpsChangeStatus;
};

type EnvironmentStatusResult = Pick<EnvironmentStatus, 'key' | 'status'>;

function stateLabel(state: string): string {
  return state
    .toLowerCase()
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function statusClass(
  classes: ReturnType<typeof useStyles>,
  state: DeploymentState | undefined,
): string {
  if (state === 'READY') return classes.ready;
  if (state === 'FAILED') return classes.failed;
  if (
    state === 'SYNC_PENDING' ||
    state === 'RECONCILING' ||
    state === 'DEPLOYING'
  ) {
    return classes.warning;
  }
  return '';
}

function matchesEnvironment(
  environment: Environment,
  key: (typeof ENVIRONMENTS)[number]['key'],
): boolean {
  const names = [environment.name, environment.resourceName]
    .filter((name): name is string => Boolean(name))
    .map(name => name.toLowerCase());
  const aliases: Record<(typeof ENVIRONMENTS)[number]['key'], string[]> = {
    development: ['development', 'dev'],
    staging: ['staging', 'stage'],
    production: ['production', 'prod'],
  };
  return names.some(name => aliases[key].includes(name));
}

export const GitOpsStatusCard = () => {
  const classes = useStyles();
  const { entity } = useEntity();
  const client = useApi(openChoreoClientApiRef);
  const features = useOpenChoreoFeatures();
  const query = useOpenChoreoQuery<EnvironmentStatusResult[]>(
    ['gitops-overview-status', stringifyEntityRef(entity)],
    async () => {
      const environments = (await client.fetchEnvironmentInfo(
        entity,
      )) as Environment[];
      return Promise.all(
        ENVIRONMENTS.map(async target => {
          const environment = environments.find(env =>
            matchesEnvironment(env, target.key),
          );
          if (!environment) return { key: target.key };

          return {
            key: target.key,
            status: await client.fetchGitOpsChangeStatus(
              entity,
              environment.resourceName ?? environment.name,
            ),
          };
        }),
      );
    },
    { enabled: features.gitops.enabled },
  );
  const environmentResults = query.data ?? [];
  const statuses = environmentResults.flatMap(result =>
    result.status ? [result.status] : [],
  );

  const environmentStatuses = useMemo(
    () =>
      ENVIRONMENTS.map(environment => ({
        ...environment,
        status: environmentResults.find(
          result => result.key === environment.key,
        )?.status,
      })),
    [environmentResults],
  );
  const latestPromotion = useMemo(
    () =>
      statuses
        .filter(status => status.pullRequest.number !== undefined)
        .sort(
          (left, right) =>
            new Date(right.pullRequest.promotedAt ?? 0).getTime() -
            new Date(left.pullRequest.promotedAt ?? 0).getTime(),
        )[0],
    [statuses],
  );
  const lastUpdated = useMemo(
    () =>
      statuses
        .map(status => status.lastCheckedAt)
        .filter((timestamp): timestamp is string => Boolean(timestamp))
        .sort(
          (left, right) => new Date(right).getTime() - new Date(left).getTime(),
        )[0],
    [statuses],
  );

  if (!features.gitops.enabled) return null;

  return (
    <Card padding={16} className={classes.card}>
      <Box className={classes.header}>
        <Typography className={classes.title}>GitOps status</Typography>
        <Tooltip title="Refresh GitOps status">
          <span>
            <IconButton
              size="small"
              onClick={() => query.refetch()}
              disabled={query.loading || query.isRefetching}
              aria-label="Refresh GitOps status"
            >
              {query.loading || query.isRefetching ? (
                <CircularProgress size={18} />
              ) : (
                <RefreshIcon fontSize="small" />
              )}
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      {query.loading && (
        <Box className={classes.content}>
          <Skeleton variant="text" width="100%" height={24} />
          <Skeleton variant="text" width="100%" height={24} />
          <Skeleton variant="text" width="100%" height={24} />
        </Box>
      )}

      {query.error && (
        <Alert severity="error">
          Failed to load GitOps status: {query.error.message}
        </Alert>
      )}

      {!query.loading && !query.error && (
        <Box className={classes.content}>
          {environmentStatuses.map(({ key, label, status }) => (
            <Box className={classes.environmentRow} key={key}>
              <Typography variant="body2" className={classes.environmentName}>
                {label}
              </Typography>
              <Chip
                size="small"
                className={statusClass(classes, status?.deployment.state)}
                label={
                  status
                    ? stateLabel(status.deployment.state)
                    : 'Not configured'
                }
              />
            </Box>
          ))}

          <Box>
            <Typography variant="caption" color="textSecondary">
              Latest promotion
            </Typography>
            {latestPromotion?.pullRequest.number !== undefined ? (
              <Box display="flex" alignItems="center" gridGap={8}>
                {latestPromotion.pullRequest.url ? (
                  <MaterialLink
                    href={latestPromotion.pullRequest.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="body2"
                  >
                    PR #{latestPromotion.pullRequest.number}
                  </MaterialLink>
                ) : (
                  <Typography variant="body2">
                    PR #{latestPromotion.pullRequest.number}
                  </Typography>
                )}
                <Chip
                  size="small"
                  label={stateLabel(latestPromotion.pullRequest.state)}
                />
              </Box>
            ) : (
              <Typography variant="body2">No promotion PR recorded</Typography>
            )}
          </Box>

          <Typography variant="caption" color="textSecondary">
            Last updated: {lastUpdated ? formatRelativeTime(lastUpdated) : '—'}
          </Typography>
        </Box>
      )}

      <Box className={classes.actions}>
        <Link to="environments" style={{ textDecoration: 'none' }}>
          <Button variant="outlined" color="primary" size="small">
            View details
          </Button>
        </Link>
      </Box>
    </Card>
  );
};
