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
