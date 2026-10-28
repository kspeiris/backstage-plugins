import {
  Box,
  Button,
  Chip,
  IconButton,
  Link,
  Tooltip,
  Typography,
} from '@material-ui/core';
import { makeStyles } from '@material-ui/core/styles';
import CircularProgress from '@material-ui/core/CircularProgress';
import RefreshIcon from '@material-ui/icons/Refresh';
import Alert from '@material-ui/lab/Alert';
import { formatRelativeTime } from '@openchoreo/backstage-plugin-react';
import type { GitOpsChangeStatus } from '@openchoreo/backstage-plugin-common';
import type { Entity } from '@backstage/catalog-model';
import { useGitOpsStatus } from '../hooks/useGitOpsStatus';

const useStyles = makeStyles(theme => ({
  section: {
    borderTop: `1px solid ${theme.palette.divider}`,
    padding: theme.spacing(2, 2.5),
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
  },
  heading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    minWidth: 0,
  },
  label: {
    width: 92,
    flexShrink: 0,
  },
  metadata: {
    color: theme.palette.text.secondary,
  },
  positiveChip: {
    backgroundColor: theme.palette.success.light,
    color: theme.palette.success.dark,
  },
  warningChip: {
    backgroundColor: theme.palette.warning.light,
    color: theme.palette.warning.dark,
  },
  negativeChip: {
    backgroundColor: theme.palette.error.light,
    color: theme.palette.error.dark,
  },
}));

function stateLabel(state: string): string {
  return state
    .toLowerCase()
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function chipClass(
  classes: ReturnType<typeof useStyles>,
  state:
    | GitOpsChangeStatus['pullRequest']['state']
    | GitOpsChangeStatus['deployment']['state'],
): string {
  if (state === 'READY' || state === 'MERGED') return classes.positiveChip;
  if (state === 'FAILED' || state === 'CLOSED') return classes.negativeChip;
  if (
    state === 'OPEN' ||
    state === 'IN_REVIEW' ||
    state === 'SYNC_PENDING' ||
    state === 'RECONCILING' ||
    state === 'DEPLOYING'
  ) {
    return classes.warningChip;
  }
  return '';
}

export interface GitOpsChangeStatusPanelProps {
  entity: Entity;
  environment: string;
  refreshKey?: number;
}

export const GitOpsChangeStatusPanel = ({
  entity,
  environment,
  refreshKey,
}: GitOpsChangeStatusPanelProps) => {
  const classes = useStyles();
  const { data, loading, isRefetching, error, refetch, enabled } =
    useGitOpsStatus({ entity, environment, refreshKey });

  if (!enabled) return null;

  return (
    <Box className={classes.section} aria-label="GitOps change status">
      <Box className={classes.heading}>
        <Typography variant="subtitle2">GitOps change</Typography>
        <Tooltip title="Refresh GitOps status">
          <span>
            <IconButton
              size="small"
              onClick={() => refetch()}
              disabled={loading || isRefetching}
              aria-label="Refresh GitOps status"
            >
              {loading || isRefetching ? (
                <CircularProgress size={16} />
              ) : (
                <RefreshIcon fontSize="small" />
              )}
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      {loading && (
        <Typography variant="body2" color="textSecondary">
          Loading GitOps status…
        </Typography>
      )}

      {error && (
        <Alert
          severity="error"
          action={
            <IconButton
              color="inherit"
              size="small"
              onClick={() => refetch()}
              aria-label="Retry GitOps status"
            >
              <RefreshIcon fontSize="small" />
            </IconButton>
          }
        >
          Unable to load GitOps status. Refresh to try again.
        </Alert>
      )}

      {data && (
        <>
          <Box className={classes.row}>
            <Typography variant="caption" className={classes.label}>
              Pull request
            </Typography>
            <Chip
              size="small"
              className={chipClass(classes, data.pullRequest.state)}
              label={stateLabel(data.pullRequest.state)}
            />
            {data.pullRequest.isStale && (
              <Tooltip title="GitHub could not be reached. This is the last known pull request state.">
                <Chip
                  size="small"
                  className={classes.warningChip}
                  label="Stale"
                />
              </Tooltip>
            )}
            {data.pullRequest.number !== undefined &&
              (data.pullRequest.url ? (
                <Link
                  href={data.pullRequest.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="body2"
                >
                  PR #{data.pullRequest.number}
                </Link>
              ) : (
                <Typography variant="body2">
                  PR #{data.pullRequest.number}
                </Typography>
              ))}
          </Box>

          <Box className={classes.row}>
            <Typography variant="caption" className={classes.label}>
              Deployment
            </Typography>
            <Chip
              size="small"
              className={chipClass(classes, data.deployment.state)}
              label={stateLabel(data.deployment.state)}
            />
          </Box>

          {data.pullRequest.mergeCommitSha && (
            <Typography variant="caption" className={classes.metadata}>
              Merged revision: {data.pullRequest.mergeCommitSha}
            </Typography>
          )}
          {data.lastCheckedAt && (
            <Typography variant="caption" className={classes.metadata}>
              Checked {formatRelativeTime(data.lastCheckedAt)}
            </Typography>
          )}
          {data.diagnostics?.map((diagnostic, index) => (
            <Alert
              key={`${diagnostic.source}-${diagnostic.reason ?? index}`}
              severity={diagnostic.source === 'GitHub' ? 'warning' : 'error'}
              action={
                <Box display="flex" alignItems="center" gridGap={8}>
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => refetch()}
                    disabled={loading || isRefetching}
                  >
                    Refresh status
                  </Button>
                  {data.pullRequest.url && (
                    <Link
                      href={data.pullRequest.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      variant="body2"
                    >
                      View Pull Request
                    </Link>
                  )}
                </Box>
              }
            >
              <Typography variant="subtitle2">
                {diagnostic.source === 'GitHub'
                  ? `Pull Request Status: ${stateLabel(data.pullRequest.state)}`
                  : diagnostic.reason === 'DeploymentStatusUnavailable'
                  ? 'Deployment Status: Unavailable'
                  : diagnostic.reason === 'GitHubStatusUnavailable'
                  ? 'Pull Request Status: Unavailable'
                  : `Deployment Status: ${stateLabel(data.deployment.state)}`}
              </Typography>
              <Typography variant="body2">
                Source: {diagnostic.source}
              </Typography>
              {diagnostic.reason && (
                <Typography variant="body2">
                  Reason: {diagnostic.reason}
                </Typography>
              )}
              <Typography variant="body2">{diagnostic.message}</Typography>
              {(diagnostic.lastCheckedAt || data.lastCheckedAt) && (
                <Typography variant="caption" display="block">
                  Last checked:{' '}
                  {formatRelativeTime(
                    diagnostic.lastCheckedAt ?? data.lastCheckedAt!,
                  )}
                </Typography>
              )}
            </Alert>
          ))}
          {data.deployment.state !== 'READY' &&
            data.deployment.state !== 'FAILED' &&
            (data.deployment.statusReason || data.deployment.statusMessage) && (
              <Alert
                severity={
                  data.deployment.state === 'FAILED' ? 'error' : 'warning'
                }
              >
                {data.deployment.statusReason && (
                  <Typography variant="body2">
                    Reason: {data.deployment.statusReason}
                  </Typography>
                )}
                {data.deployment.statusMessage && (
                  <Typography variant="body2">
                    {data.deployment.statusMessage}
                  </Typography>
                )}
              </Alert>
            )}
        </>
      )}
    </Box>
  );
};
