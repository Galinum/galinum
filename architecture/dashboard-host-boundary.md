# Dashboard host boundary

## Problem

The reusable package owns dashboard components and complete supervision pages.
A managed host may load product data through private infrastructure. A
self-host operator supplies its own dashboard host. Shared pages use the
public management API contract without receiving host identity, framework,
database, or credential objects.

A managed host may store only one-way project secret hashes. Its adapter must
authorize in-process management requests without recovering or forwarding a
plaintext project secret.

## Caller usage

A host resolves the viewer and project once. It then binds those values to a
management executor and opens the shared dashboard.

```ts
const dashboard = createDashboard({
  async open() {
    const { project } = await resolveAuthorizedProject();
    return {
      project: { id: projectId(project.id), name: project.name },
      viewer: { name: viewer.name },
      management: createManagementClient(hostManagementExecutor(project)),
    };
  },
  Link: HostLink,
  docsUrl: "https://docs.galinum.com",
});
```

A managed-host route keeps only framework routing.

```tsx
export default async function Page({ searchParams }) {
  return dashboard.pages.campaigns({
    query: parseCampaignListLocation(await searchParams),
  });
}
```

Self-host binds the same management client to its local product executor. The operator owns authentication in front of the mount. The package never stores or forwards an administrator secret.

## Shape

`@galinum/core/contract` owns browser-safe contract and dashboard domain types. Identifiers use branded strings. Campaign lifecycle, channel, audience, and delivery state use discriminated unions. The server derives these types from the OpenAPI contract and checks each field mapping.

`@galinum/server` owns `ManagementExecutor`, response parsing, the
project-bound `ManagementClient`, the fetch executor, and reusable
behavioral conformance scenarios. The executor accepts a `Request` and
returns a `Response`. HTTP and host adapters stay outside dashboard exports.

`@galinum/dashboard` owns page composition, location parsing, navigation destinations, and supervision commands. A host provides one `open()` function and one `href()` function. The dashboard never receives a database, a Next.js object, or a raw credential.

The managed host owns its identity provider, project selection, role checks,
and in-process route executor. Self-host owns its authentication boundary and
mounts the same pages over the local executor.

A dashboard request crosses three ownership layers:

1. The host resolves identity and binds one project.
2. The dashboard selects the management operation and renders its result.
3. The management implementation loads product data.

## Synthesis decision

The base design is the project-bound management client. It matches the
existing `Request` to `Response` executors in the product and its managed
consumer. It also keeps host authentication server-side.

The design takes two ideas from the alternative candidate. Pure contract types move to `@galinum/core/contract`, so dashboard does not install server database dependencies. Self-host gets a runnable mount, but the product does not choose an authentication scheme.

The design rejects public transport request objects because they would
duplicate the web protocol. It rejects fetch-only managed access because a
host may not retain recoverable project secrets. It rejects separate loader
and page-data exports because they repeat one page representation across a
public boundary. It also rejects dashboard response models that are not
derived from OpenAPI.

## Tradeoffs accepted

- A managed host serializes requests through its real route handlers. This proves shared pages use the public contract.
- Server owns response parsing. This keeps loose JSON and HTTP errors out of dashboard code.
- Self-host requires an operator authentication boundary. This keeps security policy out of the reusable package.
- The first page units remain read-only. Campaign launch, pause, and end follow through one separately verified command.

## Verification

A page must render or execute the same seeded scenario through both executors.
Static route-export checks remain a fast gate. Behavioral conformance is the
completion proof.

## Boundary today

The reusable dashboard owns all shared supervision pages. Exact product
releases carry the package and stylesheet to managed hosts. The package
exports reusable conformance scenarios so each host can prove its adapter
against the same management behavior.

Email previews, approval policy, project membership, billing, and operations
remain host-owned. Client bundles contain no server executor or credential.
