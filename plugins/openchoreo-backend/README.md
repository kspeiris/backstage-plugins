# @openchoreo/backstage-plugin-backend

The core Backstage **backend** plugin for [OpenChoreo](https://openchoreo.dev).

It mounts at `/api/openchoreo` and serves the OpenChoreo control plane to the
OpenChoreo frontend plugins — projects, components, environments, deployments,
promotions, workload configuration, secrets, and access control — attaching the
caller's identity provider token to each upstream call.

This plugin is required by [`@openchoreo/backstage-plugin`](https://www.npmjs.com/package/@openchoreo/backstage-plugin);
install the two together.

## GitOps change status API

The GitOps tracker stores one promotion record per namespace, project,
component, and environment in the plugin's Backstage database. The record is
preserved across backend restarts. The status endpoint refreshes the recorded
pull request from GitHub and reads the current deployment from OpenChoreo.

GitHub API credentials are resolved from Backstage's `integrations.github`
configuration. This supports configured GitHub tokens and GitHub App
credentials. The credential needs permission to read pull requests in the
configured GitOps repositories; it remains backend-only.

```http
GET /api/openchoreo/gitops/status?project=default&component=biocare-web&environment=staging
```

The `namespace` query parameter is optional and defaults to `default`.
Deployment status is retrieved using the caller's OpenChoreo identity token.
For a promotion outside the default namespace, pass `namespace` explicitly.

The `promote-openchoreo-component` scaffolder template records the PR it
creates. To record a PR manually, call the authenticated promotion endpoint:

```http
POST /api/openchoreo/gitops/promotions
Content-Type: application/json

{
  "namespaceName": "default",
  "projectName": "default",
  "componentName": "biocare-web",
  "environment": "staging",
  "repositoryUrl": "https://github.com/OWNER/REPOSITORY",
  "pullRequestUrl": "https://github.com/OWNER/REPOSITORY/pull/17"
}
```

The tracker validates that the PR URL belongs to the supplied repository and
derives its number from that URL. The API reports pull-request and deployment
states separately. Missing promotion records return `NOT_CREATED`; when a
GitHub refresh fails, the last known PR state is returned with
`pullRequest.isStale: true` and the timestamp of the last successful check.

## Installation

```bash
yarn workspace backend add @openchoreo/backstage-plugin-backend
```

```ts title="packages/backend/src/index.ts"
backend.add(import('@openchoreo/backstage-plugin-backend'));
```

`@openchoreo/openchoreo-client-node` and the other shared libraries are dependencies of
this package, so there is nothing else to install for it to work. You will separately
want `@openchoreo/openchoreo-auth` in your backend, because the IDP token middleware it
provides has to be wired into the root router by hand.

Configuration lives in two places, and they are not interchangeable. The control plane
URL goes in `openchoreo.baseUrl`, and `openchoreo.auth` holds the **service** client
credentials used for background work such as the catalog entity provider. The
**sign-in** client is separate, under `auth.providers.openchoreo-auth` — see
[`@openchoreo/backstage-plugin-auth-backend-module-openchoreo-auth`](https://www.npmjs.com/package/@openchoreo/backstage-plugin-auth-backend-module-openchoreo-auth).

**Full setup instructions** — including the IDP token middleware the plugin depends on:
[Installing into an existing Backstage app](https://openchoreo.dev/docs/platform-engineer-guide/backstage-plugins/installing-into-existing-backstage/).

## Documentation

- [Backstage plugins overview](https://openchoreo.dev/docs/platform-engineer-guide/backstage-plugins/overview/)
- [Troubleshooting](https://openchoreo.dev/docs/platform-engineer-guide/backstage-plugins/troubleshooting/)

## License

Apache-2.0
