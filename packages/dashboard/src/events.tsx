import type { ReactNode } from "react";
import { Activity } from "lucide-react";
import { dateTimeFormat } from "./date-time.js";
import type { DashboardLink, DashboardManagement } from "./dashboard-types.js";
import { PageHeader } from "./components/page-header.js";
import { relativeTime } from "./relative-time.js";
import { Button } from "./ui/button.js";
import { Card } from "./ui/card.js";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table.js";

export type EventRange = "" | "24h" | "7d" | "30d";

const rangeMs = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
} as const;

export type EventsManagement = DashboardManagement<"listEvents">;
export type EventsPageProps = {
  management: EventsManagement;
  projectName: string;
  query: { q: string; range: EventRange; page: number };
  controls?: ReactNode;
  docsUrl: string;
  Link: DashboardLink;
  renderPagination?: (page: { page: number; pageCount: number; total: number }) => ReactNode;
  now?: number;
};

export async function EventsPage({
  management,
  projectName,
  query,
  controls,
  docsUrl,
  Link,
  renderPagination,
  now = Date.now(),
}: EventsPageProps) {
  const events = await management.listEvents({
    q: query.q || undefined,
    page: Math.min(Math.max(1, query.page), 10_000),
    perPage: 50,
    since: query.range ? now - rangeMs[query.range] : undefined,
    until: query.range ? now : undefined,
  });
  if (events.pageCount > 0 && query.page > events.pageCount) {
    return EventsPage({
      management,
      projectName,
      query: { ...query, page: events.pageCount },
      controls,
      docsUrl,
      Link,
      renderPagination,
      now,
    });
  }
  const filtering = query.q.length > 0 || query.range.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Events" description={`Everything ${projectName} tracked, newest first.`} />

      {events.total === 0 && !filtering ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Activity /></EmptyMedia>
            <EmptyTitle>No events yet</EmptyTitle>
            <EmptyDescription>
              Events show up here as soon as your app calls <code className="font-mono text-xs">track()</code> through the Galinum SDK.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button nativeButton={false} render={<a href={docsUrl} target="_blank" rel="noreferrer" />}>
              Read the quickstart
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          {controls && <div className="flex flex-wrap items-center gap-2">{controls}</div>}

          {events.values.length === 0 ? (
            <Card className="items-center py-12 text-sm text-muted-foreground">No events match your filters.</Card>
          ) : (
            <Card className="overflow-hidden py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Event</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Properties</TableHead>
                    <TableHead className="pr-5 text-right">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="ph-no-capture">
                  {events.values.map((event) => {
                    const properties = event.props && Object.keys(event.props).length > 0
                      ? JSON.stringify(event.props)
                      : null;
                    return (
                      <TableRow key={event.id}>
                        <TableCell className="pl-5 font-mono text-xs font-medium">{event.name}</TableCell>
                        <TableCell>
                          <Link
                            href={`/users/${event.endUserId}`}
                            className="block max-w-44 truncate text-muted-foreground hover:text-foreground hover:underline"
                          >
                            {event.externalUserId}
                          </Link>
                        </TableCell>
                        <TableCell className="max-w-72">
                          <code className="block truncate text-xs text-muted-foreground" title={properties ?? undefined}>
                            {properties ?? "—"}
                          </code>
                        </TableCell>
                        <TableCell
                          className="pr-5 text-right whitespace-nowrap text-muted-foreground"
                          title={dateTimeFormat.format(event.ts)}
                        >
                          {relativeTime(event.ts, now)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
          )}

          {renderPagination?.(events)}
        </>
      )}
    </div>
  );
}
