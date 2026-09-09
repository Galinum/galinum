# Run Galinum locally

This example starts the single-project Galinum server and Postgres 17.

```bash
docker compose -f examples/self-host/compose.yaml up --build
```

Check the server:

```bash
curl http://localhost:3000/api/health
```

The Compose file contains development-only keys. Replace both keys before exposing the server outside your machine.
It binds port 3000 only on `127.0.0.1` and sets `GALINUM_PUBLIC_URL=http://localhost:3000`, so the development keys and uploaded media stay local. Change the bind address, public origin, and keys together before exposing the server.

The current self-host build supports the local web in-app path. It does not include Galinum Cloud billing, organizations, managed email delivery, hosted-agent scheduling, backups, or operations.

## Mount the dashboard

`@galinum/dashboard/mount` exposes the complete supervision page set without choosing an authentication framework. Bind one authenticated operator and one project in `open()`:

The Compose example starts the API, not a web host. The following integration
sketch uses two host-provided values: `authenticatedManagementExecutor`
executes authorized management requests, and `OperatorLink` integrates the
host router.

```tsx
import { createDashboard } from "@galinum/dashboard/mount";
import { createManagementClient } from "@galinum/server/management-client";

const dashboard = createDashboard({
  open: async () => ({
    project: { id: "local", name: "Local product" },
    viewer: { name: "Operator" },
    management: createManagementClient(authenticatedManagementExecutor),
  }),
  Link: OperatorLink,
  docsUrl: "https://docs.galinum.com",
});
```

Mount `dashboard.pages.*` in the operator-authenticated routes of your React server. Keep the management executor and secret on the server.

Compile the dashboard with Tailwind CSS v4. Import Tailwind and the package stylesheet from the global CSS entry your host includes in its layout:

```css
@import "tailwindcss";
@import "@galinum/dashboard/tokens.css";
```

The package stylesheet registers the dashboard's built JavaScript as a Tailwind source and supplies its semantic tokens. Serve the compiled CSS, not the raw imports.

## Upgrade installation lifecycle storage

An existing Postgres volume does not rerun `schema.sql` when the API image changes.
Back up the database and stop API workers before applying
`packages/server/upgrades/installations.sql` once, using a DDL-capable connection:

```bash
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f packages/server/upgrades/installations.sql
```

Run this command from the product repository root. It transactionally adds only
the installation tables and index. Restart the API after success. Skip this
upgrade for databases initialized with the current schema. See
[installation lifecycle](../../apps/docs/sdk/installations.mdx) for replay limits,
authentication and verification reads.

## Push worker

The CLI polls push campaigns automatically after launch, applies delivery windows,
and runs bounded retries. The default poll interval is 1000 ms; configure
`GALINUM_PUSH_WORKER_INTERVAL_MS` between 100 and 60000 ms. Library hosts call
`product.push.runDue()` explicitly. No overlapping worker passes run in one CLI.

Set `GALINUM_PUSH_ENCRYPTION_KEY` to a stable base64-encoded 32-byte random key
before configuring persistent app credentials. Compose passes this setting from
your environment. Store it separately from database backups. Management reads
never expose private credentials. See [push delivery](../../apps/docs/push.mdx)
for configuration, native categories and idempotent selected-device tests.

Existing installation-enabled databases require the separate transactional
`packages/server/upgrades/push.sql` before upgrading the API. Stop workers, back
up, then run `psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f packages/server/upgrades/push.sql`
from the repository root. Fresh databases already contain this schema.


## In-app receipt upgrade

Existing databases require the separate transactional
packages/server/upgrades/inapp.sql after the installation and push upgrades.
Back up and stop API workers, apply it with psql -X -v ON_ERROR_STOP=1 -f,
then update SDK callers together with the server. Fresh schema initialization
already includes the receipt table. Each actual shown operation has a stable
feedbackId; retries preserve it, while distinct committed renders get new IDs.
Receipt storage is indexed per operation, without a lifetime replay cap.
## Upgrade an existing database

Apply the activation upgrade before starting this version against a database created with the previous schema:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/server/migrations/activation-1.sql
```

The upgrade preserves existing campaigns and deliveries. It does not approve campaigns, attach source changes, or launch messages. A fresh database initialized with the current `schema.sql` already includes this upgrade. Do not apply it twice.

The server checks the recorded schema version before starting. Use `pnpm verify:activation-upgrade` to rehearse the upgrade against disposable loopback databases.

## Campaign supervision

Compose the public campaign page or dashboard mount with `createManagementClient`
and the required `createPushSupervisionClient`. Both use the host's server-only,
project-authorized executor. The host passes `pushQuery` and
`pushInspectionHref` to preserve navigation state. See the complete
[dashboard composition example](../../apps/docs/self-host/dashboard.mdx).
