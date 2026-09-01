# Compatibility policy

Galinum has not published a stable release. The current source and package
artifacts use `0.x` versions.

## Supported runtime

- Node.js 24.
- pnpm 10.15.0 for repository development.
- PostgreSQL 17 for persistent self-host deployments.
- React 19 for the reusable dashboard package.
- React 18 or later for `@galinum/react`.

The clean-clone gate installs from the public npm registry with no registry
credentials. It then runs the full verification suite and starts the
in-memory server without application secrets.

## Contract changes

`apps/docs/openapi.json` is the management API contract. Contract changes,
server operation changes, documentation, and the distributable skill must
land in one product commit.

The release tool versions `@galinum/core`, `@galinum/dashboard`,
`@galinum/react`, `@galinum/server`, and the distributable skill together. A
consumer must install one exact release and verify every recorded digest.

Before a stable release, a minor version may contain a breaking contract
change. The pull request and release notes must identify the break. After a
stable release, Galinum will follow semantic versioning.

## Excluded compatibility promises

Galinum Cloud operations, billing, tenancy, and observability are managed
services. This policy does not promise source or API compatibility for those
systems.
