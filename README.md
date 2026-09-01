# Galinum

Galinum is self-driving product communications. A product team's agent uses
the management API and distributable skill to create, target, launch, and
measure timely messages.

This monorepo owns the reusable product, public contracts, and a
single-project self-host server. Galinum Cloud consumes exact product releases
and owns its own billing, tenancy, and operations.

## Repository map

| Path | Purpose |
| --- | --- |
| `apps/docs` | Customer documentation, OpenAPI, MCP metadata, and the distributable skill |
| `packages/core` | Product-only campaign, audience, targeting, delivery, and adapter contracts |
| `packages/dashboard` | Reusable supervision pages and a framework-neutral host mount |
| `packages/react` | React SDK for identifying users, tracking events, and rendering in-app messages |
| `packages/server` | Contract-generated management API, local adapter, and product Postgres schema |
| `examples/self-host` | Node 24 and Postgres 17 Compose example |
| `examples/react-nextjs` | Next.js App Router example for the React SDK |
| `scripts` | Workspace, contract, schema, release, and affected-package checks |

## Development

Use Node 24 and pnpm 10.15.0.

```bash
corepack enable
pnpm install
pnpm verify
```

Run `pnpm verify:affected -- --base <commit>` to use the same path selection as CI.

## Project policies

- [Compatibility](COMPATIBILITY.md)
- [Contributing](CONTRIBUTING.md)
- [Feature matrix](FEATURE_MATRIX.md)
- [Release policy](RELEASE.md)
- [Security](SECURITY.md)
- [Support](SUPPORT.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Run the local product

Build and start the in-memory single-project server:

```bash
pnpm build
PORT=3000 GALINUM_PUBLIC_URL=http://localhost:3000 pnpm --filter @galinum/server start
```

The server prints development-only secret and publishable keys when you do not configure them. It binds the public management and SDK routes from `apps/docs/openapi.json`.
`GALINUM_HOST` defaults to `127.0.0.1`. Set it to `0.0.0.0` only when a
container or network boundary protects the server.
`GALINUM_PUBLIC_URL` must be an HTTP(S) origin with no path, credentials, query, or fragment. The in-memory media store defaults it to `http://localhost:<PORT>` and prints a warning. Persistent `GALINUM_MEDIA_DIR` storage requires an explicit value.

To start the server with Postgres 17:

```bash
docker compose -f examples/self-host/compose.yaml up --build
```

The current self-host path supports local web in-app campaigns. It does not include Galinum Cloud organizations, billing, managed email delivery, hosted-agent scheduling, backups, or operations.

## License

Galinum is licensed under [Apache-2.0](LICENSE). Read
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the included
third-party components.
