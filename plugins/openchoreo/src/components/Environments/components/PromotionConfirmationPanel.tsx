import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Grid,
  Link,
  Paper,
  CircularProgress,
  Typography,
} from '@material-ui/core';
import Alert from '@material-ui/lab/Alert';

export type PromotionState =
  | 'idle'
  | 'validating'
  | 'generating'
  | 'preview-ready'
  | 'checking-conflicts'
  | 'conflict-found'
  | 'creating-pr'
  | 'success'
  | 'error';

export interface PromotionPullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  author?: string;
}

export interface PromotionConfirmationPanelProps {
  open: boolean;
  componentName: string;
  projectName: string;
  currentReleaseName: string;
  proposedReleaseName: string;
  targetEnvironment: string;
  repositoryName: string;
  targetBranch: string;
  targetPath: string;
  state?: PromotionState;
  errorMessage?: string;
  taskUrl?: string;
  existingPullRequest?: PromotionPullRequest;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  pullRequestTitle?: string;
  loading?: boolean;
  onCancel: () => void;
  onReviewChanges: () => void;
}

/**
 * Review step shown before a promotion is handed to the GitOps workflow.
 *
 * This component intentionally only presents values supplied by the caller;
 * release and repository data must come from the selected component,
 * deployment pipeline, and generated manifest rather than being inferred in
 * the UI.
 */
export const PromotionConfirmationPanel = ({
  open,
  componentName,
  projectName,
  currentReleaseName,
  proposedReleaseName,
  targetEnvironment,
  repositoryName,
  targetBranch,
  targetPath,
  state = 'idle',
  errorMessage,
  taskUrl,
  existingPullRequest,
  pullRequestNumber,
  pullRequestUrl,
  pullRequestTitle,
  loading = false,
  onCancel,
  onReviewChanges,
}: PromotionConfirmationPanelProps) => (
  <Dialog open={open} onClose={onCancel} maxWidth="sm" fullWidth>
    <DialogTitle>Promote component</DialogTitle>
    <DialogContent>
      {state !== 'idle' && state !== 'preview-ready' && (
        <Alert
          severity={
            state === 'error'
              ? 'error'
              : state === 'success'
              ? 'success'
              : 'info'
          }
          icon={loading ? <CircularProgress size={18} /> : undefined}
          style={{ marginBottom: 16 }}
        >
          {state === 'validating' && 'Validating promotion...'}
          {state === 'generating' && 'Generating ReleaseBinding...'}
          {state === 'checking-conflicts' &&
            'Checking for conflicting pull requests...'}
          {state === 'creating-pr' && 'Creating GitHub pull request...'}
          {state === 'conflict-found' &&
            'An existing pull request already modifies this promotion.'}
          {state === 'success' &&
            'Pull request created. The change is not deployed yet.'}
          {state === 'error' &&
            (errorMessage || 'The promotion could not be completed.')}
        </Alert>
      )}

      {state === 'conflict-found' && existingPullRequest && (
        <Paper variant="outlined" style={{ padding: 16, marginBottom: 16 }}>
          <Typography variant="subtitle2">Existing pull request</Typography>
          <Typography variant="body2">
            PR #{existingPullRequest.number}: {existingPullRequest.title}
          </Typography>
          <Typography variant="body2">
            State: {existingPullRequest.state}
          </Typography>
          <Link
            href={existingPullRequest.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            View existing pull request
          </Link>
        </Paper>
      )}

      {state === 'success' && pullRequestUrl && (
        <Paper variant="outlined" style={{ padding: 16, marginBottom: 16 }}>
          <Typography variant="subtitle2">Pull Request Created</Typography>
          {pullRequestNumber !== undefined && (
            <Typography variant="body2">PR #{pullRequestNumber}</Typography>
          )}
          {pullRequestTitle && (
            <Typography variant="body2">{pullRequestTitle}</Typography>
          )}
          <Link href={pullRequestUrl} target="_blank" rel="noopener noreferrer">
            View pull request
          </Link>
          <Typography variant="body2" color="textSecondary">
            Target file: {targetPath}
          </Typography>
        </Paper>
      )}

      {taskUrl && state === 'error' && (
        <Typography variant="body2" gutterBottom>
          <Link href={taskUrl} target="_blank" rel="noopener noreferrer">
            View task logs
          </Link>
        </Typography>
      )}

      <Grid container spacing={2}>
        <Grid item xs={6}>
          <Typography variant="caption" color="textSecondary">
            Component
          </Typography>
          <Typography variant="body1">{componentName}</Typography>
        </Grid>
        <Grid item xs={6}>
          <Typography variant="caption" color="textSecondary">
            Project
          </Typography>
          <Typography variant="body1">{projectName}</Typography>
        </Grid>
        <Grid item xs={6}>
          <Typography variant="caption" color="textSecondary">
            Current release
          </Typography>
          <Typography variant="body1">{currentReleaseName}</Typography>
        </Grid>
        <Grid item xs={6}>
          <Typography variant="caption" color="textSecondary">
            Target environment
          </Typography>
          <Typography variant="body1">{targetEnvironment}</Typography>
        </Grid>
      </Grid>

      <Divider style={{ margin: '24px 0 16px' }} />
      <Typography variant="subtitle1" gutterBottom>
        Review your change
      </Typography>
      <Paper variant="outlined" style={{ padding: 16 }}>
        <Typography variant="body2">Current release</Typography>
        <Typography variant="body2" color="textSecondary">
          {currentReleaseName}
        </Typography>
        <Typography variant="body2" color="textSecondary" align="center">
          ↓
        </Typography>
        <Typography variant="body2">Proposed release</Typography>
        <Typography variant="body2" color="textSecondary">
          {proposedReleaseName}
        </Typography>
        <Typography variant="body2" color="textSecondary" align="center">
          ↓
        </Typography>
        <Typography variant="body2">ReleaseBinding update</Typography>
      </Paper>

      <Divider style={{ margin: '24px 0 16px' }} />
      <Typography variant="subtitle1" gutterBottom>
        GitOps destination
      </Typography>
      <Typography variant="body2">Repository: {repositoryName}</Typography>
      <Typography variant="body2">Branch: {targetBranch}</Typography>
      <Typography variant="body2" color="textSecondary">
        Target file: {targetPath}
      </Typography>
    </DialogContent>
    <DialogActions>
      <Button onClick={onCancel} disabled={loading}>
        Cancel
      </Button>
      <Button
        onClick={onReviewChanges}
        color="primary"
        variant="contained"
        disabled={loading}
      >
        {loading
          ? 'Preparing...'
          : state === 'success'
          ? 'Close'
          : 'Review changes'}
      </Button>
    </DialogActions>
  </Dialog>
);
