# Galinum management API reference (agent-facing)

Base URL `https://galinum.com` (or `$GALINUM_API_BASE`). A customer-owned agent
uses the project's **secret key**. Galinum's hosted agent uses its dedicated
`pk_agent_…` key. Both are bearer tokens:

This reference describes REST routes. The separate hosted full MCP endpoint is
`https://mcp.galinum.com/mcp`. Do not prefix the REST paths below with that MCP
URL. `https://galinum.com/mcp` is not a compatibility endpoint.

```
Authorization: Bearer $GALINUM_SECRET_KEY
Content-Type: application/json
```

They are server-to-server only (not CORS-enabled). These are the **only**
agent-facing endpoints; nothing else exists (no DELETE anywhere).

The hosted key is deliberately narrower. It can read campaign, goal, delivery,
event, usage, user, and agent state, and it can call the hosted evaluation and
proposal endpoints below. Ordinary campaign, status, goal, segment, and media
writes return `403`; hosted campaign changes must use the lease-fenced
`/evaluations/{campaignId}/mutate` endpoint. Revoking the hosted key does not
rotate the customer's project secret.

Conventions:

- All timestamps in responses are **epoch milliseconds**. Time filters accept
  epoch ms or an ISO-8601 date string.
- Paginated endpoints take `page` (default 1) and `perPage` (default 50,
  max 100) and return `{ ..., "total", "page", "pageCount" }`.
- Errors are `{ "error": "<message>" }` with status `400` (validation, the
  message says exactly what's wrong), `401` (bad/missing/wrong-type key),
  `404` (not in this project), `409` (invalid status transition or unmet
  email launch precondition), `429`
  (rate limited — honor `Retry-After`; limits are 60/min and 1000/hour).

---

## Goals

### GET /api/v1/goals

Query: `status` — `active` | `archived` (optional). Returns up to 100 goals,
newest first:

```json
{ "goals": [ {
  "id": "goal_…", "name": "Activate new workspaces",
  "description": "Get signups to create their first board within 7 days",
  "targetEvent": "activated_workspace",
  "guardrails": { "tone": "friendly, no urgency tactics", "maxActiveCampaigns": 2 },
  "approvalMode": "require_human",
  "status": "active", "createdAt": 1752969600000
} ] }
```

- `approvalMode` is `require_human` (propose-only) or `auto`.
- `guardrails` is a free-form JSON object (or `null`) — binding instructions.
- `targetEvent` is the tracked event name the goal moves (or `null`).

### GET /api/v1/goals/{id}

`{ "goal": { … } }` — same shape. 404 if not in this project.

### POST /api/v1/goals

Body: `name` (required, ≤ 80 chars), `description` (≤ 1000), `targetEvent`
(≤ 80), `guardrails` (JSON object, ≤ 4096 bytes serialized), `approvalMode`
(`require_human` | `auto`; defaults to `require_human`). `status` cannot be
set on create. Returns `201 { "goal": { … } }`.

### PATCH /api/v1/goals/{id}

Any subset of the create fields plus `status` (`active` | `archived`).
Explicit `null` clears `description` / `targetEvent` / `guardrails`.
Returns `200 { "goal": { … } }`.

> Goals belong to the customer, and these endpoints are the only way to
> author them. Only create or modify one when explicitly asked to.

---

## Agent runs (your memory)

### GET /api/v1/agent-runs

Query: `kind`, `goalId`, `campaignId`, `page`, `perPage`. Newest first:

```json
{ "runs": [ {
  "id": "run_…", "kind": "proposal", "goalId": "goal_…", "campaignId": null,
  "input": { "segmentSize": 412 },
  "output": { "name": "Nudge: first board", "message": { … }, "targeting": { … } },
  "rationale": "412 free-plan users active this week haven't created a board…",
  "createdAt": 1752969600000
} ], "total": 12, "page": 1, "pageCount": 1 }
```

### POST /api/v1/agent-runs

Body:

- `kind` — required, ≤ 64 chars. Convention used by this skill:
  `observation`, `proposal`, `launch`, `schedule`, `evaluation`,
  `iteration`, `conclusion`, `rejected`.
- `input` / `output` — optional JSON object or array, each ≤ 16384 bytes
  serialized.
- `rationale` — optional string, ≤ 4000 chars.
- `goalId` — optional; must be a goal id in this project (else 400). Set it
  when the run serves a goal (the optimization loop); omit it for direct
  communications, which have no goal.
- `campaignId` — optional in general, but **required** for the hosted-loop
  kinds `evaluate`, `propose`, `mutate`, and `approval`, so every hosted
  decision names the campaign it acted on. `GET` accepts `?campaignId=` and
  responses return it. Also set it on each `schedule` run that hands one
  campaign to the hosted queue, so the hosted evaluator can recall that
  decision by campaign.
- `idempotencyKey` — optional, non-empty, ≤ 128 chars, unique per project. A replay with
  the same key returns the original run as `200` instead of creating a second
  one. Use a deterministic key whenever a retry could duplicate a decision.

Returns `201 { "run": { … } }` — or `200` on an idempotent replay.

---

## Users (read-only)

### GET /api/v1/users

Query: `q` (substring match on external user id), `traitKey` + `traitValue`
(must be provided together; exact match on the text form of a stored string,
number, or boolean trait),
`activeSince`, `firstSeenSince`, `page`, `perPage`.

```json
{ "users": [ {
  "id": "eu_…", "externalUserId": "user_123",
  "traits": { "plan": "free", "$browser": "Chrome" },
  "firstSeenAt": 1752969600000, "lastSeenAt": 1752969600000
} ], "total": 412, "page": 1, "pageCount": 9 }
```

`$`-prefixed traits are auto-collected context (browser, OS, locale, …).

### GET /api/v1/users/{id}

Accepts the Galinum id (`eu_…`) **or** the customer's own external user id.
`{ "user": { … } }`.

---

## Events (read-only)

### GET /api/v1/events

Query: `name` (exact event name), `userId` (Galinum `eu_…` id),
`externalUserId`, `since`, `until`, `page`, `perPage`. Newest first:

```json
{ "events": [ {
  "id": "evt_…", "name": "activated_workspace",
  "props": { "boards": 1 }, "ts": 1752969600000,
  "endUserId": "eu_…", "externalUserId": "user_123"
} ], "total": 87, "page": 1, "pageCount": 2 }
```

---

## Audiences

The audience surface is how you decide **who** receives a campaign. The
workflow is always: **discover** the project's vocabulary → **author** an
expression → **check** it (no side effects) → attach it to a campaign.
Never author against guessed trait or event names — discover first.

### The audience expression

One versioned JSON rule with explicit nodes:

```json
{ "version": 1, "root": {
  "kind": "all", "children": [
    { "kind": "field", "field": { "kind": "trait", "key": "plan" },
      "op": "eq", "value": "free" },
    { "kind": "field", "field": { "kind": "user", "field": "lastSeenAt" },
      "op": "within_last", "value": { "amount": 30, "unit": "days" } },
    { "kind": "not", "child": { "kind": "event", "event": "used_csv_export" } },
    { "kind": "event", "event": "exported",
      "count": { "op": "gte", "value": 3 },
      "window": { "amount": 7, "unit": "days" },
      "where": [ { "kind": "field",
        "field": { "kind": "event_property", "key": "format" },
        "op": "eq", "value": "csv" } ] }
  ] } }
```

- Node kinds: `all` / `any` (1–16 `children`), `not` (one `child`),
  `field`, `event`. Nesting ≤ 8 deep, ≤ 64 nodes total.
- Field references are structured: `{ "kind": "trait", "key": … }` (top-level
  trait), `{ "kind": "user", "field": "firstSeenAt" | "lastSeenAt" }`
  (lifecycle timestamps), `{ "kind": "event_property", "key": … }` (only
  inside an event's `where`).
- Operators: `eq`, `neq`, `in`, `not_in` (≤ 50 all-string or all-number
  values), `contains`, `starts_with`, `ends_with` (strings),
  `gt`, `gte`, `lt`, `lte` (numbers), `exists`, `not_exists` (no value),
  `before`, `after` (ISO-8601 with explicit offset), `within_last`,
  `not_within_last` (`{ "amount": n, "unit": "minutes"|"hours"|"days" }`).
  Lifecycle fields take only datetime/existence operators.
- Event nodes: `count` defaults to at-least-once
  (`{ "op": "gte", "value": 1 }`); "has never fired X" is
  `not` + `event`, or `count: { "op": "eq", "value": 0 }`. `window`
  restricts which occurrences count. `where` (≤ 8 conditions, ANDed per
  occurrence) filters on top-level event properties. Evaluation considers a
  user's most recent occurrences of the referenced event up to the published
  `maxEvaluatedEventOccurrences` limit (see capabilities) — far beyond any
  expressible count.
- Semantics are **strict**: no type coercion (`"1"` never equals `1`), and a
  value comparison on an absent or type-mismatched field simply does not
  match — absence is expressed only with `exists`/`not_exists`. All relative
  rules in one evaluation share a single `evaluatedAt` instant.

### GET /api/v1/audiences/capabilities

The project's audience vocabulary in one bounded response — call this
before authoring:

- `expression` — supported versions, node kinds, operators per value type,
  window units, and validation limits.
- `lifecycleFields` — `firstSeenAt`/`lastSeenAt` (datetime).
- `traits` — observed trait keys with per-type user counts (a key showing
  two types means the data is inconsistent — compare on the dominant type),
  plus bounded representative `values` for low-cardinality string traits.
- `events` — observed event names with distinct-user counts, total
  occurrences, `lastSeenAt` recency, and observed top-level property keys
  with their types.
- `traitsTruncated` / `eventsTruncated` / `propertiesTruncated` — when true,
  the list hit its bound: absence from it is NOT evidence a name doesn't
  exist.

### POST /api/v1/audiences/check

Body: `{ "expression": { … }, "sampleLimit": 0–25 (default 10) }`. Evaluates
without persisting or launching anything:

```json
{ "expression": { … normalized canonical form … },
  "expressionHash": "sha256…",
  "summary": "trait plan is \"free\" and not (performed used_csv_export)",
  "diagnostics": [ { "severity": "warning", "code": "unobserved_event",
    "path": "/root/children/1", "message": "…",
    "suggestions": ["used_csv_export"] } ],
  "evaluatedAt": 1753000000000, "countType": "exact",
  "matchedCount": 412, "totalUsers": 8210,
  "samples": [ { "externalUserId": "user_123", "firstSeenAt": …,
    "lastSeenAt": …, "traits": { "plan": "free" },
    "events": { "used_csv_export": 0 } } ] }
```

Invalid expressions are 400 with error `diagnostics` (stable `code`, JSON
Pointer `path`). Warnings (unobserved names with typo suggestions,
`zero_matches`) don't block — but **always check before launching**: a
surprising `matchedCount` or an `unobserved_trait` warning usually means a
wrong name, and the fix costs one more check call. Samples include only the
referenced traits/events, so they stay small; sample event counts are as
evaluated, bounded by `maxEvaluatedEventOccurrences`.

### POST /api/v1/audiences/explain

Body: `{ "expression": { … }, "userId": "eu_… or your external id" }`.
Returns why that one user matches or doesn't:

```json
{ "user": { "externalUserId": "user_123", … }, "matched": false,
  "evaluatedAt": …, "expressionHash": "…",
  "trace": { "path": "/root", "kind": "all", "matched": false,
    "children": [
      { "path": "/root/children/0", "kind": "field", "matched": true,
        "op": "eq", "observed": "free", "observedType": "string" },
      { "path": "/root/children/1", "kind": "event", "matched": false,
        "event": "exported", "occurrences": 1,
        "required": { "op": "gte", "value": 3 }, "windowCutoff": … } ] } }
```

The trace mirrors the tree of `all`/`any`/`not`/`field`/`event` nodes with
per-node evidence: observed value and type for field conditions (`note`
explains absence/type mismatches), occurrence counts and window cutoffs for
events. An event's `where` conditions are folded into its `occurrences`
(only occurrences passing every property filter count) rather than traced
per property. 404 if the user isn't in this project.

Both check and explain also evaluate a **saved segment** instead of an
inline expression: pass `"segment": "id-or-key"` (+ optional `"version": n`)
in place of `expression` — never both. The response then includes
`"segment": { "id", "key", "version" }` alongside the usual fields.

### Segments — reusable named audiences

A segment is a saved audience with a stable machine key: create it once,
reference it from any campaign by key, revise it safely. Segment membership
stays dynamic (users flow in and out as their data changes), but every
revision is an immutable numbered version and campaigns pin exact versions —
revising a segment never silently changes a running campaign.

Use a segment when an audience will be reused across campaigns or evolved
over time; use an inline `expression` for one-off audiences. There is no
delete — archive instead.

### POST /api/v1/segments

Body: `{ "key", "name", "expression", "description"?, "reason"?,
"agentRunId"?, "idempotencyKey"? }`.

- `key` — required, ≤ 64 chars, lowercase slug (`[a-z0-9_-]`, no leading or
  trailing separator, must not start with `seg_`), unique per project. This
  is the stable identifier campaigns and future sessions reference — choose
  it like a good variable name and never recycle it for a different meaning.
- `name` ≤ 80 chars; `description` ≤ 1000 chars describes the audience's
  *intent*, not a rendering of its rules.
- `expression` — the audience rule (check it first).
- **Always pass `idempotencyKey`** (any unique string ≤ 128 chars): a retry
  with the same key returns the originally created segment as 200 instead
  of failing. Without one, a duplicate `key` is a 409.

Returns `201 { "segment": { … } }` (detail shape: metadata + current
version's expression, hash, and summary) — or 200 on idempotent replay.

### GET /api/v1/segments

Query: `status` — `active` | `archived` (optional). Up to 100, newest
first; compact shape (id, key, name, description, status, currentVersion,
currentAudienceVersionId, summary, timestamps) — no expressions. Fetch a
segment's detail or a version read when you need the exact rule.

### GET /api/v1/segments/{id}

`{id}` is the opaque id (`seg_…`) or the machine key — everywhere below
too. Detail = compact shape + `schemaVersion`, `expression` (current,
canonical), `expressionHash`, `reason`.

### PATCH /api/v1/segments/{id}

Any subset of:

- `name` / `description` — metadata only; no new version.
- `expression` + `expectedVersion` (+ `reason`, `agentRunId`) — replace the
  rule: creates the next immutable version atomically and advances
  `currentVersion`. `expectedVersion` must be the version you last read; a
  stale value is
  `409 { "error": …, "currentVersion": n }` — re-read the segment, re-check
  your expression, and retry with the fresh version. Always carry a concise
  `reason` — it is the version's audit note.
- Campaigns pinned to earlier versions are never touched. New campaigns
  referencing the segment without a version pick up the new current one.
- Archived segments accept metadata edits but refuse revision (409).

### POST /api/v1/segments/{id}/archive

Retires the segment from new work: campaign writes referencing it are
refused (409) and its rules can no longer be revised. Version history stays
readable and campaigns already pinned to its versions keep delivering
unchanged. Archiving twice is a 409. There is no delete and no unarchive.

### GET /api/v1/segments/{id}/versions

`{ "segmentId", "versions": [ { "audienceVersionId", "version",
"schemaVersion", "expressionHash", "summary", "reason", "agentRunId",
"createdBy", "createdAt" } ] }` — newest first, compact (no expressions).

### GET /api/v1/segments/{id}/versions/{version}

One immutable version including its exact canonical `expression`. Valid
forever, including for archived segments.

---

## Campaigns

Web in-app message content:

```json
{
  "title": "CSV export is here 📊",
  "body": "Export any table to CSV from the toolbar.",
  "cta": { "label": "Try it", "url": "/exports" },
  "media": {
    "url": "https://storage.galinum.com/projects/prj_123/campaign-media/9c2f….png",
    "alt": "The new export button in the table toolbar"
  },
  "presentation": "toast"
}
```

- `title` ≤ 120 chars, `body` ≤ 600; at least one of the two is required.
- `cta.label` is required if `cta` is present; `cta.url` is optional but must
  be `https://`, `http://`, `mailto:`, or a path starting with `/`.
- `presentation` is **required**: `"toast"` (compact bottom-right card) or
  `"modal"` (centered announcement over a full-screen backdrop). Omitting it
  or sending another value is a 400. Choose the least interruptive option
  that satisfies the request — default `toast`, `modal` for flagship or
  explicitly requested announcements.
- `media` is optional — one image per message, and it is content, not
  prominence: it never changes the presentation. A toast shows it as a
  compact thumbnail; a modal shows it as the immersive visual. `media.url`
  must be a managed URL returned by `POST /api/v1/campaign-media` for this
  project (external, data:, or another project's URLs are 400). Exactly one
  of `media.alt` (≤ 300 chars, what the image shows) or
  `media.decorative: true` is required.
- The referenced object must still exist. A campaign create or PATCH checks
  storage before it writes. If the object is missing, the write is a 400.
  Upload the image again and retry with the new URL. If storage cannot
  be reached, the write is a 503 (`Could not verify the media object right
  now. Try again.`) and is safe to retry unchanged.
- Campaigns created before `presentation` existed have no stored value; the
  delivery API resolves one (media → `modal`, no media → `toast`). Editing
  such a campaign's message requires stating `presentation` explicitly.

Email message content:

```json
{
  "subject": "CSV export is ready",
  "previewText": "Download any table in one click",
  "body": "# CSV export is here\n\nDownload any table from the toolbar.",
  "cta": { "label": "Try CSV export", "url": "https://app.example.com/exports" }
}
```

- `subject` is required and ≤ 200 chars. `previewText` is optional and ≤ 200.
- `body` is required Markdown, ≤ 50,000 chars. Galinum renders it on the
  server and adds the project's company address and unsubscribe footer.
- `cta` is optional. When present, both label and an absolute `http://` or
  `https://` URL are required.
- `title`, `presentation`, and `media` are web in-app only and are rejected
  on email. Campaign `pages` is also web in-app only.
- The recipient is the end user's `email` trait. Missing or invalid emails
  are ineligible. Unsubscribed, bounced, and complaining addresses are
  suppressed across all campaign email in the project.
- An accepted campaign email makes the recipient active for MAU billing. Each
  recipient counts once per period in that project. Sends rejected before
  provider acceptance, suppressed, failed before acceptance, or
  frequency-capped do not accrue MAU.
- Galinum accepts at most 3 campaign emails per project recipient in any
  rolling 24-hour window, across all campaigns. A send above the limit is a
  permanent `frequency_capped` skip for this campaign, not a delayed send.
  Transactional service email is exempt.

### POST /api/v1/campaign-media

Upload an image for use as message media — upload first, then reference the
returned URL from a campaign create or PATCH. The request is
`multipart/form-data` (not JSON) with one `file` field:

```
curl -X POST $GALINUM_API_BASE/api/v1/campaign-media \
  -H "Authorization: Bearer $GALINUM_SECRET_KEY" \
  -F "file=@announcement.png;type=image/png"
```

- Accepts PNG, JPEG, WebP, and GIF (animation preserved). ≤ 4 MB,
  ≤ 4096×4096 pixels. Bytes are verified server-side: SVG, non-images, and
  files whose content doesn't match their declared type are 400.
- Returns `201 { "media": { "url", "contentType", "width", "height",
  "sizeBytes" } }`. The absolute URL uses this server's configured public origin.
- Objects are immutable — to change an image, upload a new file and PATCH the
  campaign. Uploaded objects remain retained. There is no delete endpoint.

Audience (who receives the campaign): the `audience` field on campaign
create/PATCH — see the **Audiences** section below for the expression
language and the discover → author → check workflow. `null` or
`{ "kind": "all" }` targets everyone. The old flat `targeting` shape
(`{ "traits": { … }, "events": { "seen": […], "not_seen": […] } }`) is still
accepted as deprecated shorthand — same semantics, normalized automatically —
but prefer `audience`, which is strictly more expressive.

Pages (where the campaign may render): the optional `pages` field on campaign
create/PATCH. Audience decides **who**, pages decides **where**.

Pages apply only to `web_inapp`. Email campaign create and PATCH reject them.

- `pages` is an array of path patterns, or `null` (the default) for every
  page. A pattern starts with `/`, `*` matches any characters (including
  `/`), and everything else is literal and case-sensitive. Trailing slashes
  are normalized; query strings and hashes are ignored.
  Example: `["/dashboard", "/settings/*"]`.
- Limits: at most 20 patterns, each ≤ 256 characters. An empty array means
  every page (same as `null`).
- The browser SDK matches patterns against the current pathname. An SDK that
  does not declare the `pages` capability never receives page-targeted
  campaigns, so an old SDK can't show them on the wrong screen.
- A user sees at most one message per page view. Messages appear at page load
  or right after a navigation, never mid-screen.

Stats shape (campaign-level and per-variant) always includes
`sent`, `frequencyCapped`, `delivered`, `shown`, `opened`, `clicked`,
`dismissed`, `bounced`, `complained`, `unsubscribed`, and `converted`. Web in-app uses the
shown/clicked/dismissed funnel. Email uses sent/delivered/opened/clicked/
bounced/complained/unsubscribed; `frequencyCapped` counts recipients skipped
by the project-wide email limit. Each user
receives each campaign at most once; `shown` counts messages that actually
rendered on screen (the SDK reports the impression when a message mounts —
fetching alone does not count, and a page-targeted message the user never
reaches stays `queued`). `clicked`/`dismissed` count what the product
reports back as delivery feedback through the SDK. `converted` moves two
ways: `converted` SDK feedback, and — for a campaign linked to a goal via
`goalId` — automatically, when a tracked event matching the goal's
`targetEvent` fires after the channel exposure: `shownAt` for web in-app or
`deliveredAt` for email. For campaigns without a
`goalId` (direct and outcome-measured communications), `converted` still
counts only SDK feedback, so it stays 0 in products that never send it
(measure a tracked outcome through
`/api/v1/campaigns/{id}/conversions?event=` instead).

Delivery window (optional, per campaign): `deliverFrom` / `deliverUntil` are
the REQUESTED window, distinct from the actual `startedAt`/`endedAt`
lifecycle timestamps. A running campaign delivers only while
`deliverFrom <= now < deliverUntil` — the SDK receives nothing before the
start instant or at/after expiry. Both boundaries take effect automatically
and exactly, so an expiring campaign needs nobody to come back and end it.
Responses also carry a derived `effectiveStatus`:
`draft | scheduled | running | paused | expired | ended` — `scheduled` is a
running campaign before its window opens, `expired` one at/past
`deliverUntil` (expiry outranks paused; `expired` is never stored — extend
`deliverUntil` to re-open the window, plus the `launch` action if the
campaign was paused).

### POST /api/v1/campaigns

Body:

- `name` — required, ≤ 80 chars.
- `channel` — `web_inapp` (default) or `email`.
- Exactly one of:
  - `message` — a single variant named "A", or
  - `variants` — 1–10 of `{ "name": "A" (≤ 40 chars, defaults A/B/C…),
    "message": { … }, "weight": 0–100 integer (default 1),
    "isControl": bool }`. At most one control (first variant if none
    flagged); at least one variant needs weight > 0.
- `audience` — optional; `null` / `{ "kind": "all" }` = everyone,
  `{ "kind": "expression", "expression": { … }, "reason": "…" }` for an
  inline rule, or `{ "kind": "segment", "segment": "id-or-key",
  "version": n? }` to pin a saved segment (omitted version = its current
  one, resolved at write time; archived segments are 409). See Audiences
  below; check expressions first. The deprecated flat `targeting` shape is
  still accepted instead (never both).
- `pages` — web in-app only. Optional path patterns limiting where the message
  may render; omit or `null` for every page. Email rejects this field.
- `goalId` — optional; must be a goal id in this project (else 400). Links
  the campaign to the goal so tracked events matching the goal's
  `targetEvent` automatically resolve deliveries to `converted` (see the
  stats shape above). Use it in the optimized loop; direct and
  outcome-measured communications have no goal to link.
- `launch` — optional boolean; `true` creates the campaign already `running`,
  otherwise it is a `draft`.
- `deliverFrom` / `deliverUntil` — optional delivery window, each epoch
  **milliseconds** or ISO-8601 **with an explicit timezone offset**
  (`2026-08-01T09:00:00Z`, `2026-08-01T09:00:00-03:00`; offsetless or
  date-only strings are 400, as are epoch values below 10^12).
  `deliverFrom` must be earlier than `deliverUntil`, and `deliverUntil` must
  be in the future. `launch: true` plus a future `deliverFrom` schedules the
  start (`effectiveStatus: "scheduled"` until the window opens — no later
  launch call needed).

Returns `201 { "campaign": { … } }` (detail shape, below). `createdBy` is
`"api"`. Draft email creation works before domain verification. Launching
email returns 409 until a human verifies the project domain under
**Settings → Email** and the from address uses that exact domain.

### GET /api/v1/campaigns

Query: `status` — `draft` | `scheduled` | `running` | `paused` | `expired` |
`ended` (optional; filters by EFFECTIVE status — `running` excludes
campaigns whose window hasn't opened or has ended, `paused` excludes those
whose window has ended). Up to 100, ordered by `createdAt` then id ascending:

```json
{ "campaigns": [ {
  "id": "cmp_…", "name": "Launch: CSV export", "status": "running",
  "effectiveStatus": "running", "channel": "web_inapp", "goalId": null,
  "createdBy": "api",
  "createdAt": 1752969600000, "startedAt": 1752969600000, "endedAt": null,
  "deliverFrom": null, "deliverUntil": 1753574400000,
  "audience": { "kind": "expression", "audienceVersionId": "aud_…",
    "schemaVersion": 1, "expression": { "version": 1, "root": { … } },
    "expressionHash": "…", "summary": "not (performed used_csv_export)",
    "reason": "users who haven't tried the export yet", "legacy": false },
  "targeting": null,
  "pages": ["/dashboard", "/settings/*"],
  "stats": { "shown": 240, "clicked": 32, "dismissed": 110,
    "frequencyCapped": 0, "converted": 12 }
} ] }
```

`pages` is `null` when the campaign renders on every page.

`audience.kind` is `all` (everyone), `expression` (an inline rule with its
pinned `audienceVersionId` — `legacy: true` and a null version id mean the
campaign still stores the deprecated flat shape), `segment` (a saved
segment version: `segmentId`, `segmentKey`, `segmentVersion`,
`audienceVersionId`, and the exact `expression` in effect), or `invalid`
(the stored audience can no longer be read; the campaign delivers to
**nobody** until you PATCH a new audience — invalid audiences fail closed,
never widen to everyone).

### GET /api/v1/campaigns/{id}

Detail = the list shape plus `variants`, each with its own stats:

```json
{ "campaign": { …,
  "variants": [ {
    "id": "var_…", "name": "A", "weight": 1, "isControl": true,
    "content": { "title": "…", "body": "…", "cta": { … } },
    "stats": { "shown": 120, "clicked": 20, "dismissed": 50,
      "frequencyCapped": 0, "converted": 8 }
  } ]
} }
```

### PATCH /api/v1/campaigns/{id}

Any subset of:

- `name` — rename.
- `audience` — replace the audience; `null` / `{ "kind": "all" }` clears it
  (back to everyone). A new expression creates a NEW immutable audience
  version pinned by the campaign; a segment reference re-pins to that
  segment's chosen version. Reads always show the exact expression now in
  effect (superseded inline versions are retained internally but have no
  public read endpoint; segment versions are readable through the segments
  API). Existing queued/shown deliveries are unaffected (audience changes
  only affect users without a delivery). The deprecated `targeting` field
  still works the same way (never both in one request).
- `goalId` — link the campaign to a goal in this project; `null` unlinks.
  Linking takes effect for target events tracked from then on (it never
  rewrites past deliveries).
- `pages` — replace the page patterns; `null` or `[]` clears them (back to
  every page). Existing deliveries are unaffected: a queued delivery simply
  renders on the screens the new patterns allow.
- `message` — replace the content of a **single-variant** campaign (400 if it
  has more than one variant).
- `variants` — array of patches, at most one of `message`/`variants` per
  request. Each entry **with** an `id` updates that variant (`name`,
  `message`, `weight`, `isControl` — at least one required); each entry
  **without** an `id` creates a new variant (`message` required). Rules:
  ≤ 10 variants total, unique names, at least one final weight > 0, exactly
  one control (set `isControl: true` on another variant to move it; you
  can't just unset the current control). **Variants are never deleted** —
  retire one by setting `weight: 0` (it stops being delivered).
- `deliverFrom` / `deliverUntil` — replace a delivery-window bound (same
  format and ordering rules as create); `null` clears one. Extending
  `deliverUntil` into the future is how an `expired` campaign resumes: a
  stored-`running` campaign delivers again from the PATCH alone, while a
  stored-`paused` one additionally needs the `launch` action afterwards.
  Users who already received the campaign still never see it twice.

Returns `200 { "campaign": { … } }` (fresh detail).

### POST /api/v1/campaigns/{id}/status

Body: `{ "action": "launch" | "pause" | "end" }`.
Returns `200 { "id": "cmp_…", "status": "running" | "paused" | "ended" }`.
Invalid transitions return `409` (`ended` is terminal; only `running`
campaigns can be paused; launching a running campaign is a 409). On an
`expired` campaign only `end` is allowed — `launch`/`pause` return 409;
PATCH a later `deliverUntil` first (then `launch`, if it was paused) to
resume delivery. Email launch also returns 409 until its project domain is
verified and its from address uses that domain.

### GET /api/v1/campaigns/{id}/deliveries

Query: `state` — `queued` | `sending` | `retryable` | `frequency_capped` |
`sent` | `delivered` | `shown` | `opened` |
`clicked` | `dismissed` | `bounced` | `complained` | `unsubscribed` |
`failed` | `converted` (optional) — plus `page`, `perPage`. Newest first.

Email deliveries also return nullable `sentAt`, `deliveredAt`, `openedAt`,
`bouncedAt`, `complainedAt`, and `unsubscribedAt` timestamps.

```json
{ "deliveries": [ {
  "id": "del_…", "endUserId": "eu_…", "externalUserId": "user_123",
  "variantId": "var_…", "variantName": "A", "state": "clicked",
  "queuedAt": 1752969600000, "shownAt": 1752969600000,
  "clickedAt": 1752969600000, "dismissedAt": null, "convertedAt": null
} ], "total": 240, "page": 1, "pageCount": 5 }
```

`state` is the latest resolution, but the `*At` timestamps accumulate
independently (a delivery can have both `clickedAt` and `convertedAt`).
`frequency_capped` is terminal for that campaign and recipient. It has no
`sentAt`, never accrues MAU, and is visible in campaign stats and usage.

### GET /api/v1/campaigns/{id}/conversions

Query: `event` — required tracked event name, 1–80 characters.

Returns an exact aggregate at one `evaluatedAt` instant. A delivery converts
when that user has at least one matching event at or after its channel exposure
(`shownAt` for web in-app, `deliveredAt` for email) and at or before
`evaluatedAt`. Duplicate matching events count once for that delivery. The
endpoint returns no raw event or delivery rows and is safe for large campaigns.

```json
{
  "campaignId": "cmp_…", "event": "activated_workspace",
  "evaluatedAt": 1755000000000, "exposure": "shownAt",
  "totals": {
    "exposedDeliveries": 412, "exposedUsers": 412,
    "convertedDeliveries": 61, "convertedUsers": 61
  },
  "variants": [ {
    "variantId": "var_…", "variantName": "A",
    "exposedDeliveries": 206, "exposedUsers": 206,
    "convertedDeliveries": 38, "convertedUsers": 38
  } ]
}
```

Use this when a campaign's stored `converted` counter is not wired to the
event being evaluated. Do not reconstruct exact conversion rates by combining
paginated `/events` and `/deliveries` responses.

---

## Hosted evaluation loop

These endpoints exist for a scheduled agent that evaluates goal-linked
campaigns on a recurring cadence. A customer-owned session may use `PUT
/api/v1/evaluations/{campaignId}` with its project secret to seed the hosted
queue, but claim, complete, mutate, and proposal operations belong to the
hosted runtime. They are the only way to take exclusive ownership of a
campaign evaluation, so two runners cannot evaluate the same campaign at
once. Do not seed the hosted queue when another scheduler will evaluate the
same campaign.

### GET /api/v1/agent/settings

The human safety controls the hosted loop must honor.

```json
{ "loopPaused": false, "approvalOverride": null,
  "maxRunsPerDay": 20, "maxConcurrentCampaigns": 1,
  "ai": { "creditsUsed": 0, "monthlyLimit": 2500, "limitReached": false } }
```

- `loopPaused` — when true, the loop must not claim, mutate, or open a new
  proposal. A worker that already holds a lease may still log its decision and
  call `complete` solely to release or park that lease instead of holding it
  until expiry.
- `approvalOverride` — `require_human` or `null`. It can only tighten a goal's
  `approvalMode`; it never loosens one.
- `maxRunsPerDay` — granted claims allowed per UTC day. Defaults to 20.
- `maxConcurrentCampaigns` — campaigns one project may hold in flight at once.
- `ai` — AI-credit usage for the organization in the current billing period.
  `creditsUsed` counts credits recorded this period, `monthlyLimit` is the
  organization's allowance, and `limitReached` is true once usage reaches it.
  Check `limitReached` before starting a run and skip the run when it is true.
  A run already in progress is never interrupted.

### POST /api/v1/agent/usage-reports

Report what one completed run cost, so Galinum can meter and bill AI credits.
Send it after the run finishes, once per run.

Only Galinum's hosted-agent key may call this endpoint. A project secret key
returns `403`: agents you run yourself consume no Galinum AI credits, so they
have nothing to report.

Body:

```json
{ "executionId": "ses_…", "sessionId": "ses_…", "model": "gpt-5.6-luna",
  "calls": [ { "inputTokens": 100000, "cachedInputTokens": 20000,
    "cacheWriteTokens": 0, "outputTokens": 1000 } ] }
```

- `executionId` — the run's own identifier, and the idempotency key. Required.
- `calls` — one entry per model call, so each call is priced at its own
  context tier. Required and non-empty, with 200 entries at most.
- `inputTokens` — the provider's TOTAL input for that call, already including
  cached reads and cache writes. Each token field accepts 100,000,000 at most.
- `sessionId` and `model` are optional context.

Returns `200 { "executionId": "ses_…", "credits": 7, "costMicros": 18100,
"replayed": false }`. Galinum prices the usage; do not send costs or credits.

Reporting the same `executionId` again returns the stored result with
`replayed: true` and never changes it, so a retry is safe. Malformed usage
returns `400` and records nothing.

Retry a network timeout, a `408`, a `429`, or a `5xx` with the same
`executionId`. Do not retry a `400`, a `403`, or a `409`; those describe the
report itself, so a resend cannot change the answer.

### GET /api/v1/evaluations/due

The work queue, oldest due first:

```json
{ "campaigns": [ { "campaignId": "cmp_…", "name": "Nudge: first board",
    "goalId": "goal_…", "effectiveStatus": "running",
    "nextEvaluationAt": 1755000000000, "decidedContinuation": false } ],
  "loopPaused": false, "runsUsedToday": 3, "maxRunsPerDay": 20 }
```

A campaign appears only when its evaluation-state row is due, it has a linked
active goal, its effective status is `running` or `paused`, no live lease
covers it, and no proposal for that evaluation is waiting for a human
decision. `campaigns` is always empty while the loop is paused. When the loop
is active but the daily budget is spent, an already-paid approved or rejected
continuation remains visible while fresh work is withheld. An empty list is
not evidence that nothing needs work.

### POST /api/v1/evaluations/{campaignId}/claim

Body: `{ "leaseSeconds": 1–3600 }` (default 300). Returns
`200 { "leaseToken": "lease_…", "nextEvaluationAt": 1755000000000,
"decidedContinuation": false }`.

A granted claim spends one unit of the daily budget; a refused claim spends
none. `decidedContinuation: true` resumes an approved or rejected proposal for
the same evaluation and does not spend a second daily-budget unit. `409` means
the campaign is leased, not due, ineligible, waiting for a human decision, the
loop is paused, or the budget is exhausted. `404` means the campaign is not in
this project. The lease expires on its own, so a crashed runner never stalls a
campaign.

### POST /api/v1/evaluations/{campaignId}/complete

Body: `{ "leaseToken": "lease_…", "nextEvaluationAt": <instant|null> }`.
Returns `200 { "concluded": bool, "nextEvaluationAt": <instant|null> }`.

A null `nextEvaluationAt` stops future evaluation and removes the campaign
from the queue; it does **not** stop delivery. When delivery should end, first
apply the fenced `{ "type": "status", "action": "end" }` mutation, then
complete with null. Any other value must be at least 60 seconds in the future
and inside the campaign's delivery window; a rejected reschedule returns `400`
and keeps the lease so the caller can correct it or conclude with null. A valid
value reschedules and releases the lease. A stale, expired, or already-released
token is `409`. Completion also returns `409` while an approved proposal for
that exact evaluation remains unconsumed; apply it through the fenced mutate
endpoint first. Passing null also returns `409` with `Campaign is still
eligible for evaluation; end it or make its goal ineligible before concluding`
while the campaign is running, paused, or scheduled under an active goal. These
conflicts keep the lease so the caller can take the required action and retry.
A rejected proposal does not block completion.

### PUT /api/v1/evaluations/{campaignId}

Body: `{ "nextEvaluationAt": <instant> }`. Seeds or moves a campaign's queue
row. The campaign must have an active goal and an effective status of
`running`, `paused`, or `scheduled`. For every status, `nextEvaluationAt` must
fall inside any configured delivery window: at or after `deliverFrom` and
before `deliverUntil`. Draft, ended, expired, and out-of-window evaluation
times are rejected. A live lease or any unconsumed proposal owns the current
evaluation instant, so a schedule move is rejected with `409` until it
finishes. The error distinguishes a live lease, a pending human decision, and
a decided proposal the agent has not acted on yet. Eligibility is rechecked
after the queue lock, so a concurrent campaign end, goal unlink, or goal
archive returns `400` and writes no queue row. Returns
`200 { "campaignId", "nextEvaluationAt" }`.

### POST /api/v1/evaluations/{campaignId}/mutate

The only write path for a campaign under hosted evaluation. The ordinary
campaign `PATCH` and status routes stay open to humans and a customer's own
agent; this one is fenced.

Body: `{ "leaseToken", "evaluationAt", "mutation", "approvalId"? }` where
`evaluationAt` is the epoch-ms instant `claim` returned, and `mutation` is one
of:

```json
{ "type": "status", "action": "launch" | "pause" | "end" }
{ "type": "update", "name": "…",
  "variants": [ { "id": "var_…", "name": "…", "message": { … },
    "weight": 0–100 } ] }
```

Every variant `id` is required and must already exist: the hosted loop updates
variants, it never creates them. A weight is absolute, not a delta. Weight `0`
retires a variant, but at least one sibling must remain above zero. Returns
`200 { "campaignId", "applied", "status" }`.

- `400` — malformed mutation, or a variant id this campaign does not have.
- `409` — the lease is stale or expired, `evaluationAt` is not the evaluation
  the lease claimed, the campaign is no longer eligible, or the approval does
  not match this payload.
- `403` — inspect `reason`, never infer from `payloadHash` alone.
  `approval_required` carries `{ "approvalRequired": true, "payloadHash":
  "…" }`; propose that exact payload and stop. `proposal_rejected` carries
  `{ "approvalRequired": false, "payloadHash": "…" }`; log the rejection and
  never propose or apply that exact payload again, even if approval policy later
  loosens.

### Proposals — human approval for one exact mutation

`payloadHash` is `sha256` over the canonical
`{ campaignId, evaluationAt, mutation }`. A human approves that hash, so a
mutation that differs by one field is a different proposal. Approval is exact
and single-use. While a proposal is pending, the campaign is not claimable. A
decision makes the same evaluation claimable again with its original
`evaluationAt`, so the approved payload still matches.

- `POST /api/v1/agent/proposals` — body
  `{ "campaignId", "evaluationAt", "mutation", "leaseToken",
  "proposedRunId"? }`. It verifies and releases that lease without changing
  `evaluationAt`. Every response also carries `leaseHeld`; trust it instead of
  inferring ownership from proposal status. A new proposal returns
  `201 { "proposal", "awaitingDecision": true, "leaseHeld": false }` and releases the lease. A
  retry after a lost response returns the exact existing proposal as `200`
  whenever the queue's evaluation instant and payload hash still match. This
  read-only replay happens before the live-lease, loop-pause, and campaign/goal
  eligibility guards, so it still works after the loop pauses, the campaign
  ends or expires, or the goal is unlinked or archived. Its `awaitingDecision`
  and `leaseHeld` flags report the current state; never infer either one. An
  identical approved or rejected proposal can therefore return
  `200 { "proposal", "awaitingDecision": false, "leaseHeld": true }` when the
  current claim still owns the lease, or the same response with
  `leaseHeld: false` after ownership is lost. Stop whenever `leaseHeld` is
  false. Only a new or different payload attempt goes through the live-lease,
  loop-pause, and eligibility guards and can return `409` for those failures.
- `GET /api/v1/agent/proposals?campaignId=&status=pending|approved|rejected`
  also takes `page` / `perPage` and returns
  `{ "proposals": [ … ], "total", "page", "pageCount" }`.
- A manager approves or rejects pending proposals in the dashboard's Agent
  page. There is no management-API decision endpoint, so the hosted agent
  cannot approve its own work.

> Evaluation instants are epoch milliseconds in responses. Send `evaluationAt`
> on mutation and proposal requests as the exact numeric epoch-ms value returned
> by `claim`. Schedule and completion `nextEvaluationAt` values may instead be
> epoch milliseconds or ISO-8601 strings with an explicit offset.

---

## Usage and serving state

### GET /api/v1/usage

Current-period usage for the organization that owns this project, and whether
Galinum is still serving messages.

**Check this before any email launch and before you diagnose delivery.** When
`serving` is not `ok`, `GET /api/v1/messages` returns an empty list for every
end user. When `emailServing` is not `ok`, campaign email does not send.

```json
{
  "serving": "cap_reached",
  "emailServing": "paused",
  "billable": true,
  "period": {
    "start": "2026-08-05T00:00:00.000Z",
    "end": "2026-09-05T00:00:00.000Z",
    "boundary": "subscription"
  },
  "activeUsers": 50000,
  "frequencyCapped": 12,
  "estimatedSpendUsd": 680,
  "spendCapUsd": 600,
  "projects": [ { "id": "prj_…", "name": "Acme", "activeUsers": 50000,
    "frequencyCapped": 12 } ]
}
```

- `serving`: `ok` | `payment_required` | `cap_reached`. `payment_required`
  means the organization cannot receive either channel until a human restores
  billing. `cap_reached` means usage reached the spend cap for this period.
- `emailServing`: `ok` | `paused`. It is `paused` whenever `serving` is not
  `ok`, and while billing is `past_due` even though web in-app keeps serving.
- `activeUsers`: billing counts monthly active users, not messages. An end user
  counts once per period in each project when identified, tracked, shown a web
  in-app message, or accepted for campaign email.
- `frequencyCapped`: current-period `frequency_capped` campaign-email
  deliveries across the organization. Each project includes its own count.
- `period.boundary`: `subscription` when a payment method is on file, otherwise
  `calendar_month` (UTC).
- Money fields are USD; period timestamps are ISO-8601 (not epoch ms, unlike
  every other endpoint here).

You cannot fix a paused organization through the API. Report it and tell the
human what to do in **Settings → Billing**. Serving resumes within a minute of
restoring billing or raising the spend cap.
