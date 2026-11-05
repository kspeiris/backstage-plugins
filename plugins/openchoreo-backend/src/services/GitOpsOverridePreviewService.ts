import {
  InputError,
  NotFoundError,
  ServiceUnavailableError,
} from '@backstage/errors';
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { GithubCredentialsProvider } from '@backstage/integration';
import type { GitOpsTargetConfigurationService } from './GitOpsTargetConfigurationService';
import {
  patchReleaseBindingManifest,
  generateUnifiedDiff,
  type PatchResult,
  type PatchOptions,
} from '@openchoreo/backstage-plugin-common';

export interface PreviewOverrideRequest {
  namespaceName: string;
  projectName: string;
  componentName: string;
  environment: string;
  overrides: PatchOptions;
}

export interface PreviewOverrideResponse {
  valid: boolean;
  repository: string;
  repositoryOwner: string;
  repositoryName: string;
  baseBranch: string;
  manifestPath: string;
  originalSha: string;
  originalManifest: string;
  proposedManifest: string;
  diff: string;
  changed: boolean;
  error?: string;
}

export class GitOpsOverridePreviewService {
  constructor(
    private readonly logger: LoggerService,
    private readonly targetService: GitOpsTargetConfigurationService,
    private readonly githubCredentialsProvider?: GithubCredentialsProvider,
    private readonly githubFetch: typeof fetch = fetch,
  ) {}

  async preview(
    request: PreviewOverrideRequest,
  ): Promise<PreviewOverrideResponse> {
    const {
      namespaceName,
      projectName,
      componentName,
      environment,
      overrides,
    } = request;

    this.logger.info(
      `Previewing GitOps override changes for ${namespaceName}/${projectName}/${componentName}/${environment}`,
    );

    // 1. Resolve GitOps target configuration (independent of ownership classification)
    const target = await this.targetService.findTarget({
      namespaceName,
      projectName,
      componentName,
      environment,
    });

    if (!target) {
      return {
        valid: false,
        repository: '',
        repositoryOwner: '',
        repositoryName: '',
        baseBranch: '',
        manifestPath: '',
        originalSha: '',
        originalManifest: '',
        proposedManifest: '',
        diff: '',
        changed: false,
        error:
          'GitOps target is not configured. Please contact your platform administrator.',
      };
    }

    const { repositoryOwner, repositoryName, repository, baseBranch, manifestPath } =
      target;

    if (
      target.repositoryProvider &&
      target.repositoryProvider !== 'github'
    ) {
      throw new InputError(
        'Only GitHub repositories are supported for preview',
      );
    }
    const pathSegments = manifestPath.split('/');
    if (
      pathSegments.some(
        segment => segment.length === 0 || segment === '.' || segment === '..',
      ) ||
      manifestPath.includes('\\')
    ) {
      throw new InputError(
        'Configured manifest path is not repository-relative',
      );
    }

    // 2. Fetch existing manifest from GitHub (read-only)
    const { content: originalContent, sha: originalSha } =
      await this.fetchManifestFromGitHub(
        repositoryOwner,
        repositoryName,
        baseBranch,
        manifestPath,
      );

    // 3. Patch the manifest using shared logic
    let patchResult: PatchResult;
    try {
      patchResult = patchReleaseBindingManifest(
        originalContent,
        namespaceName,
        projectName,
        componentName,
        environment,
        overrides,
      );
    } catch (error) {
      return {
        valid: false,
        repository,
        repositoryOwner,
        repositoryName,
        baseBranch,
        manifestPath,
        originalSha,
        originalManifest: originalContent,
        proposedManifest: '',
        diff: '',
        changed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // 4. Generate diff
    const diff = generateUnifiedDiff(
      originalContent,
      patchResult.proposedYaml,
      manifestPath,
    );

    return {
      valid: true,
      repository,
      repositoryOwner,
      repositoryName,
      baseBranch,
      manifestPath,
      originalSha,
      originalManifest: originalContent,
      proposedManifest: patchResult.proposedYaml,
      diff,
      changed: patchResult.changed,
    };
  }

  private async fetchManifestFromGitHub(
    owner: string,
    repo: string,
    branch: string,
    path: string,
  ): Promise<{ content: string; sha: string }> {
    const encodedPath = path
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');
    const url = `https://api.github.com/repos/${encodeURIComponent(
      owner,
    )}/${encodeURIComponent(
      repo,
    )}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;

    this.logger.debug(
      `Fetching manifest from GitHub: ${owner}/${repo}@${branch}:${path}`,
    );

    if (!this.githubCredentialsProvider) {
      throw new ServiceUnavailableError(
        'GitHub credentials provider is not configured for repository preview',
      );
    }
    let credentials;
    try {
      credentials = await this.githubCredentialsProvider.getCredentials({
        url: `https://github.com/${owner}/${repo}`,
      });
    } catch (error) {
      this.logger.error(
        `Could not obtain GitHub credentials for ${owner}/${repo}`,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw new ServiceUnavailableError(
        'Could not obtain credentials to access the configured GitHub repository',
      );
    }

    let response: Response;
    try {
      response = await this.githubFetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          ...credentials.headers,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (error) {
      this.logger.error(
        `GitHub request failed while previewing ${owner}/${repo}@${branch}:${path}`,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw new ServiceUnavailableError(
        'Could not reach GitHub to fetch the configured manifest',
      );
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new NotFoundError(
          `Manifest not found in GitHub repository: ${owner}/${repo}@${branch}:${path}`,
        );
      }
      throw new ServiceUnavailableError(
        `GitHub returned HTTP ${response.status} while reading ${owner}/${repo}@${branch}:${path}`,
      );
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      throw new ServiceUnavailableError(
        'GitHub returned an invalid response while reading the configured manifest',
      );
    }

    if (
      !responseBody ||
      typeof responseBody !== 'object' ||
      Array.isArray(responseBody)
    ) {
      throw new ServiceUnavailableError(
        'GitHub returned an invalid response while reading the configured manifest',
      );
    }

    const data = responseBody as {
      content?: string;
      encoding?: string;
      sha?: string;
      message?: string;
    };

    if (
      data.encoding !== 'base64' ||
      typeof data.content !== 'string' ||
      typeof data.sha !== 'string' ||
      !/^[0-9a-f]{40}$/i.test(data.sha)
    ) {
      throw new ServiceUnavailableError(
        'GitHub response did not contain a valid base64 manifest and file SHA',
      );
    }

    const compactBase64 = data.content.replace(/\s/g, '');
    if (
      compactBase64.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        compactBase64,
      )
    ) {
      throw new ServiceUnavailableError(
        'GitHub returned malformed base64 manifest content',
      );
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(compactBase64, 'base64'),
      );
    } catch {
      throw new ServiceUnavailableError(
        'GitHub returned manifest content that is not valid UTF-8',
      );
    }

    return { content, sha: data.sha };
  }
}

export function createGitOpsOverridePreviewService({
  logger,
  targetService,
  githubCredentialsProvider,
  githubFetch = fetch,
}: {
  logger: LoggerService;
  targetService: GitOpsTargetConfigurationService;
  githubCredentialsProvider?: GithubCredentialsProvider;
  githubFetch?: typeof fetch;
}): GitOpsOverridePreviewService {
  return new GitOpsOverridePreviewService(
    logger,
    targetService,
    githubCredentialsProvider,
    githubFetch,
  );
}
