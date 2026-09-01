# Product feature matrix

The self-host product and Galinum Cloud share product contracts and reusable
supervision pages. They do not have feature parity.

| Capability | Self-host product | Galinum Cloud |
| --- | --- | --- |
| Project model | One project | Managed organizations and projects |
| Management API | Included | Managed |
| Campaign, audience, segment, goal, and event rules | Included | Included through exact product releases |
| Supervision dashboard | Reusable package; host integration required | Included with cloud navigation and policy |
| Web in-app delivery API | Included | Managed |
| Persistent PostgreSQL storage | Included | Managed |
| Campaign media | Local memory or filesystem | Managed object storage |
| Email delivery | Not included | Managed |
| Hosted optimization agent | Not included | Managed |
| Hosted MCP endpoint and OAuth | Not included | Managed |
| Billing and entitlements | Not included | Managed |
| Organization membership and tenant provisioning | Not included | Managed |
| Backups, scaling, and operations | Operator-owned | Managed |
| `@galinum/react` source | Included | Managed |

The self-host example uses Node.js 24 and PostgreSQL 17. It starts with
development keys when you do not configure credentials. Read
[examples/self-host/README.md](examples/self-host/README.md) for the current
deployment steps and limits.
