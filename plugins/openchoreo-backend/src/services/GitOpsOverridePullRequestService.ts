import {
  ConflictError,
  InputError,
  NotFoundError,
  ServiceUnavailableError,
} from '@backstage/errors';
import crypto from 'crypto';
import type { GitOpsOverridePRIdempotencyService } from './GitOpsOverridePRIdempotencyService';
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { GithubCredentialsProvider } from '@backstage/integration';
import type { GitOpsTargetConfigurationService } from './GitOpsTargetConfigurationService';
import {
  patchReleaseBindingManifest,
  type PatchOptions,
} from '@openchoreo/backstage-plugin-common';

export interface CreatePullRequestRequest {
  namespaceName: string;
  projectName: string;
  componentName: string;
  environment: string;
  expectedSha: string;
  componentTypeEnvironmentConfigs?: Record<string, unknown>;
  traitEnvironmentConfigs?: Record<string, unknown>;
  workloadOverrides?: Record<string, unknown>;
  title?: string;
  description?: string;
  idempotencyKey?: string;
}

export interface PullRequestDetails {
  number: number;
  title: string;
  url: string;
  branch: string;
  baseBranch: string;
  commitSha?: string;
}

export interface CreatePullRequestResponse {
  success: boolean;
  changed?: boolean;
  message?: string;
  pullRequest?: PullRequestDetails;
  error?: string;
}

interface GitHubContentResponse {
  content?: string;
  encoding?: string;
  sha?: string;
}

interface GitHubRefResponse {
  object?: {
    sha?: string;
  };
}

interface GitHubPullRequestResponse {
  number: number;
  html_url: string;
  title: string;
  head: { ref: string };
  base: { ref: string };
}

export class GitOpsOverridePullRequestService {
  constructor(
    private readonly logger: LoggerService,
    private readonly targetService: GitOpsTargetConfigurationService,
    private readonly githubCredentialsProvider?: GithubCredentialsProvider,
    private readonly githubFetch: typeof fetch = fetch,
    private readonly idempotencyService?: GitOpsOverridePRIdempotencyService,
  ) {}

  async createPullRequest(
    request: CreatePullRequestRequest,
  ): Promise<CreatePullRequestResponse> {
    const {
      namespaceName,
      projectName,
      componentName,
      environment,
      expectedSha,
      title,
      description,
      idempotencyKey,
    } = request;

    this.logger.info(
      `Creating GitOps override pull request for ${namespaceName}/${projectName}/${componentName}/${environment}`,
    );

    const requestHash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          namespaceName,
          projectName,
          componentName,
          environment,
          expectedSha,
          componentTypeEnvironmentConfigs: request.componentTypeEnvironmentConfigs,
          traitEnvironmentConfigs: request.traitEnvironmentConfigs,
          workloadOverrides: request.workloadOverrides,
          title,
          description,
        }),
      )
      .digest('hex');

    if (idempotencyKey && this.idempotencyService) {
      const existing = await this.idempotencyService.get(idempotencyKey);
      if (existing) {
        if (existing.status === 'COMPLETED' && existing.resultJson) {
          try {
            return JSON.parse(existing.resultJson);
          } catch {
            // fall through
          }
        }
        if (existing.status === 'IN_PROGRESS') {
          // Wait a short time and recheck - or return existing result if completed
          const retry = await this.idempotencyService.get(idempotencyKey);
          if (retry?.status === 'COMPLETED' && retry.resultJson) {
            try {
              return JSON.parse(retry.resultJson);
            } catch {
              // fall through
            }
          }
        }
      }
      try {
        await this.idempotencyService.createInProgress({
          key: idempotencyKey,
          namespaceName,
          projectName,
          componentName,
          environment,
          requestHash,
          status: 'IN_PROGRESS',
        });
      } catch {
        // ignore
      }
    }

    const target = await this.targetService.findTarget({
      namespaceName,
      projectName,
      componentName,
      environment,
    });

    if (!target) {
      throw new NotFoundError(
        'GitOps target is not configured. Please contact your platform administrator.',
      );
    }

    const {
      repositoryOwner,
      repositoryName,
      repository,
      baseBranch,
      manifestPath,
    } = target;

    if (target.repositoryProvider && target.repositoryProvider !== 'github') {
      throw new InputError(
        'Only GitHub repositories are supported for pull request creation',
      );
    }

    const pathSegments = manifestPath.split('/');
    if (
      pathSegments.some(
        (segment: string) => segment.length === 0 || segment === '.' || segment === '..',
      ) ||
      manifestPath.includes('\\')
    ) {
      throw new InputError(
        'Configured manifest path is not repository-relative',
      );
    }

    if (
      !expectedSha ||
      typeof expectedSha !== 'string' ||
      !/^[0-9a-f]{40}$/i.test(expectedSha)
    ) {
      throw new InputError('expectedSha must be a valid Git SHA');
    }

    const overrides: PatchOptions = {};
    if (request.componentTypeEnvironmentConfigs !== undefined) {
      if (
        !request.componentTypeEnvironmentConfigs ||
        typeof request.componentTypeEnvironmentConfigs !== 'object' ||
        Array.isArray(request.componentTypeEnvironmentConfigs)
      ) {
        throw new InputError('componentTypeEnvironmentConfigs must be an object');
      }
      overrides.componentTypeEnvironmentConfigs =
        request.componentTypeEnvironmentConfigs;
    }
    if (request.traitEnvironmentConfigs !== undefined) {
      if (
        !request.traitEnvironmentConfigs ||
        typeof request.traitEnvironmentConfigs !== 'object' ||
        Array.isArray(request.traitEnvironmentConfigs)
      ) {
        throw new InputError('traitEnvironmentConfigs must be an object');
      }
      overrides.traitEnvironmentConfigs = request.traitEnvironmentConfigs;
    }
    if (request.workloadOverrides !== undefined) {
      if (
        !request.workloadOverrides ||
        typeof request.workloadOverrides !== 'object' ||
        Array.isArray(request.workloadOverrides)
      ) {
        throw new InputError('workloadOverrides must be an object');
      }
      overrides.workloadOverrides = request.workloadOverrides;
    }

    if (Object.keys(overrides).length === 0) {
      throw new InputError('At least one override section must be provided');
    }

    const credentials = await this.getCredentials(repositoryOwner, repositoryName);

    const { content: originalContent, sha: currentSha } =
      await this.fetchManifestFromGitHub(
        credentials,
        repositoryOwner,
        repositoryName,
        baseBranch,
        manifestPath,
      );

    if (currentSha.toLowerCase() !== expectedSha.toLowerCase()) {
      throw new ConflictError(
        'The GitOps manifest has changed since your preview. Please generate a new preview before creating a pull request.',
      );
    }

    let patchResult;
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
      throw new InputError(
        error instanceof Error ? error.message : String(error),
      );
    }

    if (!patchResult.changed) {
      const noChangeResult: CreatePullRequestResponse = {
        success: true,
        changed: false,
        message: 'No changes detected. Nothing needs to be submitted.',
      };
      if (idempotencyKey && this.idempotencyService) {
        try {
          await this.idempotencyService.updateCompleted(idempotencyKey, {
            resultJson: JSON.stringify(noChangeResult),
          });
        } catch {
          // ignore
        }
      }
      return noChangeResult;
    }

    const baseRef = await this.getBaseBranchRef(
      credentials,
      repositoryOwner,
      repositoryName,
      baseBranch,
    );
    const baseSha = baseRef;

    const shortId = this.generateShortId();
    const branchName = `gitops/overrides/${componentName}-${environment}-${shortId}`;

    try {
      await this.createBranch(
        credentials,
        repositoryOwner,
        repositoryName,
        branchName,
        baseSha,
      );
    } catch (error) {
      if (error instanceof ConflictError) {
        const alternativeBranch = `gitops/overrides/${componentName}-${environment}-${this.generateShortId()}-${Date.now().toString().slice(-6)}`;
        await this.createBranch(
          credentials,
          repositoryOwner,
          repositoryName,
          alternativeBranch,
          baseSha,
        );
        await this.commitFile(
          credentials,
          repositoryOwner,
          repositoryName,
          alternativeBranch,
          manifestPath,
          patchResult.proposedYaml,
          `chore(gitops): update ${componentName} overrides in ${environment}`,
          currentSha,
        );
        const pr = await this.createPullRequestGithub(
          credentials,
          repositoryOwner,
          repositoryName,
          title || `chore(gitops): update ${componentName} overrides in ${environment}`,
          description || this.buildDescription({
            namespaceName,
            projectName,
            componentName,
            environment,
            manifestPath,
            repository,
          }),
          alternativeBranch,
          baseBranch,
        );
        const altSuccessResult: CreatePullRequestResponse = {
          success: true,
          changed: true,
          pullRequest: {
            number: pr.number,
            title: pr.title,
            url: pr.html_url,
            branch: alternativeBranch,
            baseBranch,
          },
        };
        if (idempotencyKey && this.idempotencyService) {
          try {
            await this.idempotencyService.updateCompleted(idempotencyKey, {
              branchName: alternativeBranch,
              pullRequestNumber: pr.number,
              pullRequestUrl: pr.html_url,
              pullRequestTitle: pr.title,
              baseBranch,
              resultJson: JSON.stringify(altSuccessResult),
            });
          } catch {
            // ignore
          }
        }
        return altSuccessResult;
      }
      throw error;
    }

    await this.commitFile(
      credentials,
      repositoryOwner,
      repositoryName,
      branchName,
      manifestPath,
      patchResult.proposedYaml,
      `chore(gitops): update ${componentName} overrides in ${environment}`,
      currentSha,
    );

    const pr = await this.createPullRequestGithub(
      credentials,
      repositoryOwner,
      repositoryName,
      title || `chore(gitops): update ${componentName} overrides in ${environment}`,
      description || this.buildDescription({
        namespaceName,
        projectName,
        componentName,
        environment,
        manifestPath,
        repository,
      }),
      branchName,
      baseBranch,
    );

    const successResult: CreatePullRequestResponse = {
      success: true,
      changed: true,
      pullRequest: {
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        branch: branchName,
        baseBranch,
      },
    };
    if (idempotencyKey && this.idempotencyService) {
      try {
        await this.idempotencyService.updateCompleted(idempotencyKey, {
          branchName,
          pullRequestNumber: pr.number,
          pullRequestUrl: pr.html_url,
          pullRequestTitle: pr.title,
          baseBranch,
          resultJson: JSON.stringify(successResult),
        });
      } catch {
        // ignore
      }
    }
    return successResult;
  }

  private generateShortId(): string {
    return Math.random().toString(36).substring(2, 8);
  }

  private buildDescription(params: {
    namespaceName: string;
    projectName: string;
    componentName: string;
    environment: string;
    manifestPath: string;
    repository: string;
  }): string {
    return [
      '## Component Environment Override Update',
      '',
      `- Namespace: ${params.namespaceName}`,
      `- Project: ${params.projectName}`,
      `- Component: ${params.componentName}`,
      `- Environment: ${params.environment}`,
      `- Repository: ${params.repository}`,
      `- Manifest: ${params.manifestPath}`,
      '',
      '### Changes',
      'Updated component and trait environment overrides.',
      '',
      '### Validation',
      '- ReleaseBinding identity validated',
      '- Original manifest SHA verified',
      '- YAML structure validated',
    ].join('\n');
  }

  private async getCredentials(
    owner: string,
    repo: string,
  ): Promise<any> {
    if (!this.githubCredentialsProvider) {
      throw new ServiceUnavailableError(
        'GitHub credentials provider is not configured for pull request creation',
      );
    }
    try {
      const credentials = await this.githubCredentialsProvider.getCredentials({
        url: `https://github.com/${owner}/${repo}`,
      });
      return credentials;
    } catch (error) {
      this.logger.error(
        `Could not obtain GitHub credentials for ${owner}/${repo}`,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw new ServiceUnavailableError(
        'Could not obtain credentials to access the configured GitHub repository',
      );
    }
  }

  private async fetchManifestFromGitHub(
    credentials: { headers: Record<string, string> },
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
        `GitHub request failed while fetching ${owner}/${repo}@${branch}:${path}`,
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
      if (response.status === 401 || response.status === 403) {
        throw new ServiceUnavailableError(
          'GitHub authentication failed or insufficient permissions',
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

    const data = responseBody as GitHubContentResponse;
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

  private async getBaseBranchRef(
    credentials: { headers: Record<string, string> },
    owner: string,
    repo: string,
    branch: string,
  ): Promise<string> {
    const url = `https://api.github.com/repos/${encodeURIComponent(
      owner,
    )}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`;

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
        `GitHub request failed while getting base branch ref`,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw new ServiceUnavailableError('Could not reach GitHub');
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new NotFoundError(`Base branch not found: ${branch}`);
      }
      if (response.status === 401 || response.status === 403) {
        throw new ServiceUnavailableError(
          'GitHub authentication failed or insufficient permissions',
        );
      }
      throw new ServiceUnavailableError(
        `GitHub returned HTTP ${response.status} while getting base branch ref`,
      );
    }

    const data = (await response.json()) as GitHubRefResponse;
    if (!data.object?.sha) {
      throw new ServiceUnavailableError('Invalid GitHub ref response');
    }
    return data.object.sha;
  }

  private async createBranch(
    credentials: { headers: Record<string, string> },
    owner: string,
    repo: string,
    branchName: string,
    baseSha: string,
  ): Promise<void> {
    const url = `https://api.github.com/repos/${encodeURIComponent(
      owner,
    )}/${encodeURIComponent(repo)}/git/refs`;

    let response: Response;
    try {
      response = await this.githubFetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          ...credentials.headers,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: `refs/heads/${branchName}`,
          sha: baseSha,
        }),
      });
    } catch (error) {
      this.logger.error(
        `GitHub request failed while creating branch`,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw new ServiceUnavailableError('Could not reach GitHub');
    }

    if (!response.ok) {
      if (response.status === 422) {
        throw new ConflictError('Branch already exists');
      }
      if (response.status === 401 || response.status === 403) {
        throw new ServiceUnavailableError(
          'GitHub authentication failed or insufficient permissions',
        );
      }
      throw new ServiceUnavailableError(
        `GitHub returned HTTP ${response.status} while creating branch`,
      );
    }
  }

  private async commitFile(
    credentials: { headers: Record<string, string> },
    owner: string,
    repo: string,
    branch: string,
    path: string,
    content: string,
    message: string,
    sha: string,
  ): Promise<void> {
    const encodedPath = path
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');
    const url = `https://api.github.com/repos/${encodeURIComponent(
      owner,
    )}/${encodeURIComponent(repo)}/contents/${encodedPath}`;

    const base64Content = Buffer.from(content, 'utf-8').toString('base64');

    let response: Response;
    try {
      response = await this.githubFetch(url, {
        method: 'PUT',
        headers: {
          Accept: 'application/vnd.github+json',
          ...credentials.headers,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message,
          content: base64Content,
          sha,
          branch,
        }),
      });
    } catch (error) {
      this.logger.error(
        `GitHub request failed while committing file`,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw new ServiceUnavailableError('Could not reach GitHub');
    }

    if (!response.ok) {
      if (response.status === 409) {
        throw new ConflictError('File has been modified since last read');
      }
      if (response.status === 401 || response.status === 403) {
        throw new ServiceUnavailableError(
          'GitHub authentication failed or insufficient permissions',
        );
      }
      throw new ServiceUnavailableError(
        `GitHub returned HTTP ${response.status} while committing file`,
      );
    }
  }

  private async createPullRequestGithub(
    credentials: { headers: Record<string, string> },
    owner: string,
    repo: string,
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<GitHubPullRequestResponse> {
    const url = `https://api.github.com/repos/${encodeURIComponent(
      owner,
    )}/${encodeURIComponent(repo)}/pulls`;

    let response: Response;
    try {
      response = await this.githubFetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          ...credentials.headers,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title,
          body,
          head,
          base,
        }),
      });
    } catch (error) {
      this.logger.error(
        `GitHub request failed while creating pull request`,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw new ServiceUnavailableError('Could not reach GitHub');
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new ServiceUnavailableError(
          'GitHub authentication failed or insufficient permissions',
        );
      }
      if (response.status === 422) {
        throw new ConflictError('Unable to create pull request');
      }
      throw new ServiceUnavailableError(
        `GitHub returned HTTP ${response.status} while creating pull request`,
      );
    }

    return (await response.json()) as GitHubPullRequestResponse;
  }
}

export function createGitOpsOverridePullRequestService({
  logger,
  targetService,
  githubCredentialsProvider,
  githubFetch = fetch,
}: {
  logger: LoggerService;
  targetService: GitOpsTargetConfigurationService;
  githubCredentialsProvider?: GithubCredentialsProvider;
  githubFetch?: typeof fetch;
}): GitOpsOverridePullRequestService {
  return new GitOpsOverridePullRequestService(
    logger,
    targetService,
    githubCredentialsProvider,
    githubFetch,
  );
}
