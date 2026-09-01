# Contributing to Galinum

Galinum accepts fixes and focused product improvements through GitHub pull requests.

## Set up the workspace

Use Node 24 and pnpm 10.15.0.

```bash
corepack enable
pnpm install
pnpm verify
```

`pnpm verify` checks workspace metadata, package boundaries, the OpenAPI operation registry, the Postgres schema, tests, documentation links, and builds.

## Make a change

- Keep reusable product code independent of Galinum Cloud source and credentials.
- Keep one campaign, audience, channel, delivery, and conversion model.
- Add a focused test for behavior changes.
- Update `apps/docs/openapi.json` and generated operation files together when the HTTP contract changes.

Run the affected gate before opening a pull request:

```bash
pnpm verify:affected -- --base origin/main
```

Describe the user-visible outcome, the verification you ran, and any compatibility effect in the pull request.

## Report security issues privately

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](SECURITY.md).
