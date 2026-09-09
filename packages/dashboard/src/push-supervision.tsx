import type { ReactNode } from "react";
import type { PushContent, PushInspection, PushSettings } from "@galinum/core/contract";
import type { DashboardLink } from "./dashboard-types.js";
import { StatTile } from "./components/stat-tile.js";
import { Badge } from "./ui/badge.js";
import { Card, CardContent } from "./ui/card.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.js";

export type PushInspectionKind = keyof PushInspection["records"];
export type PushSupervisionQuery = { kind: PushInspectionKind; page: number };
const kinds = ["outcomes", "attempts", "targets", "observations", "recipients", "slots", "conversions"] as const;
const labels: Record<PushInspectionKind, string> = {
  outcomes: "Outcomes", attempts: "Attempts", targets: "Targets", observations: "Observations",
  recipients: "Recipients", slots: "Slots", conversions: "Conversions",
};
const linkClass = "rounded-md px-2 py-1 text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring";

export function parsePushSupervisionQuery(input: { pushKind?: string; pushPage?: string }): PushSupervisionQuery {
  const page = Number(input.pushPage);
  return {
    kind: kinds.find((kind) => kind === input.pushKind) ?? "outcomes",
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 10_000) : 1,
  };
}

function StoredValue({ value }: { value: unknown }) {
  return <pre className="max-w-full whitespace-pre-wrap break-all rounded-md bg-muted/40 p-3 font-mono text-xs">{JSON.stringify(value, null, 2)}</pre>;
}

export function PushContentView({ content }: { content: PushContent }) {
  return <div className="ph-no-capture flex min-w-0 flex-col gap-3">
    <p className="text-xs text-muted-foreground">Stored push content · Platform rendering can differ.</p>
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-4">
      <p className="whitespace-pre-wrap break-words font-semibold">{content.title}</p>
      <p className="whitespace-pre-wrap break-words">{content.body}</p>
    </div>
    <dl className="grid min-w-0 gap-3 text-sm">
      <div><dt className="text-muted-foreground">Destination · {content.destination.kind}</dt><dd className="break-all">{content.destination.url}</dd></div>
      {content.image !== undefined && <div><dt className="text-muted-foreground">Image reference</dt><dd className="break-all">{content.image}</dd></div>}
      {content.actions !== undefined && <div><dt className="text-muted-foreground">Actions · Stored labels</dt><dd><ul className="flex flex-col gap-1">{content.actions.map((action) => <li key={action.id} className="break-all">{action.title} · {action.id}</li>)}</ul></dd></div>}
      {content.data !== undefined && <div><dt className="text-muted-foreground">Custom data</dt><dd><StoredValue value={content.data} /></dd></div>}
      {content.ios !== undefined && <div><dt className="text-muted-foreground">iOS metadata</dt><dd><StoredValue value={content.ios} /></dd></div>}
      {content.android !== undefined && <div><dt className="text-muted-foreground">Android metadata</dt><dd><StoredValue value={content.android} /></dd></div>}
    </dl>
  </div>;
}

export function PushSettingsView({ settings }: { settings: PushSettings }) {
  return <section className="flex flex-col gap-3">
    <h2 className="text-lg font-semibold">Push delivery settings</h2>
    <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
      {[
        ["App ID", settings.appId],
        ["Device selection", settings.selection.kind.replaceAll("_", " ")],
        ...(settings.selection.kind === "specific" ? [["Installation ID", settings.selection.installationId]] : []),
        ["Time to live", settings.ttlSeconds === undefined ? "Not specified" : `${settings.ttlSeconds} seconds`],
        ["Replacement key", settings.replacementKey ?? "Not specified"],
      ].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="break-all">{value}</dd></div>)}
    </dl>
  </section>;
}

export function PushSummary({ inspection: p }: { inspection: PushInspection }) {
  const groups: Array<{ title: string; values: Array<[string, number]> }> = [
    { title: "Unique users", values: [["Targeted users", p.users.targeted], ["Provider accepted users", p.users.accepted], ["Engagement observed users", p.users.engaged], ["Converted users", p.users.converted]] },
    { title: "Device slots", values: [["Targeted slots", p.devices.targeted], ["Provider accepted slots", p.devices.accepted], ["Receipt observed slots", p.devices.receiptObserved], ["Receipt unknown slots", p.devices.receiptUnknown], ["Waiting slots", p.devices.waiting], ["Reserved slots awaiting outcomes", p.devices.pendingOutcomes]] },
    { title: "Submission facts", values: [["Attempts", p.devices.attempts], ["Confirmed submissions", p.devices.confirmedSubmissions], ["Possible submissions", p.devices.possibleSubmissions], ["Pre-send blocks", p.devices.preSendBlocks]] },
  ];
  return <section aria-label="Push summary" className="flex flex-col gap-6">
    <p className="text-sm text-muted-foreground">Inspection evaluated {new Date(p.evaluatedAt).toISOString()}. Navigation can show newer records.</p>
    {groups.map((group) => <div key={group.title} className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{group.title}</h2>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{group.values.map(([label, value]) => <StatTile key={label} label={label} value={value} />)}</div>
    </div>)}
    <div className="flex flex-col gap-2 text-sm text-muted-foreground">
      <p>Provider acceptance does not confirm device receipt. Receipt unknown means accepted or possibly submitted slots without receipt evidence.</p>
      <p>Engagement means an observed tap or action. Confirmed submissions can include provider rejection. These counts have different units and can overlap.</p>
      <p>Planning: {p.planning.waiting} waiting · {p.planning.active} active · {p.planning.closed} closed. Test targets: {p.testTargets}.</p>
      <p>Production totals exclude test work. Record pages can include test work.</p>
    </div>
  </section>;
}

type Column<T> = { label: string; value: (row: T) => ReactNode };
function RecordsTable<T extends { id: string }>({ rows, columns }: { rows: T[]; columns: Column<T>[] }) {
  return <Card className="min-w-0 py-0"><Table>
    <TableHeader><TableRow>{columns.map((column) => <TableHead key={column.label} scope="col">{column.label}</TableHead>)}<TableHead scope="col">Public record</TableHead></TableRow></TableHeader>
    <TableBody className="ph-no-capture">{rows.map((row) => <TableRow key={row.id}>
      {columns.map((column) => <TableCell key={column.label} className="max-w-72 whitespace-normal break-words align-top">{column.value(row)}</TableCell>)}
      <TableCell className="align-top"><details><summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">Record details</summary><div className="w-72 max-w-full"><StoredValue value={row} /></div></details></TableCell>
    </TableRow>)}</TableBody>
  </Table></Card>;
}
const stamp = (value: number) => new Date(value).toISOString();
const resultLabels = { accepted: "Provider accepted", rejected: "Provider rejected", unknown: "Submission uncertain", blocked: "Blocked before send" };
const submissionLabels = { none: "Not submitted", confirmed: "Confirmed submission", possible: "Possible submission" };

function InspectionRecords({ inspection: p, kind }: { inspection: PushInspection; kind: PushInspectionKind }) {
  switch (kind) {
    case "outcomes": return <RecordsTable rows={p.outcomes} columns={[
      { label: "Outcome", value: r => r.id }, { label: "Attempt / target / slot", value: r => <>{r.attemptId}<br />{r.targetId}<br />{r.slotId}</> },
      { label: "Observed", value: r => stamp(r.observedAt) },
      { label: "Provider result", value: r => <div className="flex flex-col gap-1"><Badge variant="outline">{resultLabels[r.result.kind]}</Badge>{r.result.code}{r.result.providerId && <span>{r.result.providerId}</span>}{r.result.retryAfterMs !== undefined && <span>Retry delay: {r.result.retryAfterMs} ms</span>}</div> },
      { label: "Submission certainty", value: r => submissionLabels[r.submission] },
    ]} />;
    case "attempts": return <RecordsTable rows={p.attempts} columns={[
      { label: "Attempt", value: r => r.id }, { label: "Target / slot", value: r => <>{r.targetId}<br />{r.slotId}</> },
      { label: "Ordinal", value: r => r.ordinal }, { label: "Started", value: r => stamp(r.startedAt) }, { label: "Valid until", value: r => stamp(r.validUntil) },
    ]} />;
    case "targets": return <RecordsTable rows={p.targets} columns={[
      { label: "Target", value: r => r.id }, { label: "User / installation", value: r => <>{r.userId}<br />{r.installationId}</> },
      { label: "Scope", value: r => r.test ? "Test" : "Production" }, { label: "Expires", value: r => stamp(r.expiresAt) },
      { label: "Replacement", value: r => <>Generation {r.generation}<br />{r.replacesTargetId ?? "No preceding target"}</> },
      { label: "Frozen personalized content", value: r => <details><summary className="cursor-pointer">Stored target content</summary><PushContentView content={r.content} /></details> },
    ]} />;
    case "observations": return <RecordsTable rows={p.observations} columns={[
      { label: "Observation", value: r => r.id }, { label: "User / installation", value: r => <>{r.userId}<br />{r.installationId}</> },
      { label: "Received", value: r => stamp(r.receivedAt) }, { label: "Command", value: r => <StoredValue value={r.command} /> },
    ]} />;
    case "recipients": return <RecordsTable rows={p.recipients} columns={[
      { label: "Recipient", value: r => r.id }, { label: "Planning state", value: r => <StoredValue value={r.state} /> },
    ]} />;
    case "slots": return <RecordsTable rows={p.slots} columns={[
      { label: "Slot", value: r => r.id }, { label: "State", value: r => <StoredValue value={r.state} /> },
    ]} />;
    case "conversions": return <RecordsTable rows={p.conversions} columns={[
      { label: "Conversion", value: r => r.id }, { label: "User", value: r => r.userId }, { label: "Event / engagement", value: r => <>{r.eventId}<br />{r.engagementId}</> }, { label: "Converted", value: r => stamp(r.convertedAt) },
    ]} />;
  }
}

export function PushSupervision({ inspection, query, href, Link }: {
  inspection: PushInspection; query: PushSupervisionQuery;
  href: (query: PushSupervisionQuery) => string; Link: DashboardLink;
}) {
  const { kind } = query;
  const page = inspection.page;
  const pageCount = inspection.pageCounts[kind];
  return <section className="flex min-w-0 flex-col gap-3" aria-label="Push inspection">
    <h2 className="text-lg font-semibold">Push inspection</h2>
    <nav aria-label="Push record collections" className="flex flex-wrap gap-2">{kinds.map((next) => <Link key={next} href={href({ kind: next, page: 1 })} className={`${linkClass} ${next === kind ? "bg-muted font-semibold" : ""}`} aria-current={next === kind ? "page" : undefined}>{labels[next]}</Link>)}</nav>
    <p className="text-sm text-muted-foreground">{inspection.records[kind]} {kind} · Page {page} of {pageCount}. Collections are paged independently; related records can be on other pages.</p>
    {inspection[kind].length ? <InspectionRecords inspection={inspection} kind={kind} /> : <p className="text-sm text-muted-foreground">{page > pageCount ? "No records on this page." : `No ${kind} yet.`}</p>}
    <nav aria-label="Push record pages" className="flex flex-wrap gap-3">
      {page > pageCount ? <Link className={linkClass} href={href({ kind, page: pageCount })}>Go to last available page</Link> : <>
        {page > 1 && <Link className={linkClass} href={href({ kind, page: page - 1 })}>Previous {kind}</Link>}
        {page < pageCount && <Link className={linkClass} href={href({ kind, page: page + 1 })}>Next {kind}</Link>}
      </>}
    </nav>
  </section>;
}

export function PushInspectionUnavailable({ accessDenied, href, Link }: { accessDenied: boolean; href: string; Link: DashboardLink }) {
  return <Card role="status"><CardContent className="flex flex-col gap-2">
    <h2 className="font-semibold">Push inspection could not be loaded</h2>
    <p className="text-sm text-muted-foreground">{accessDenied ? "Access to push inspection was denied. Check your session and project access." : "Push totals and records are unavailable. Retry to load the inspection."}</p>
    <Link className={linkClass} href={href}>Retry push inspection</Link>
  </CardContent></Card>;
}
