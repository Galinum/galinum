import type { ReactNode } from "react";
import { Users } from "lucide-react";
import { deviceLabel, locationLabel, userLabel } from "@galinum/core";
import type { DashboardLink, DashboardManagement } from "./dashboard-types.js";
import { PageHeader } from "./components/page-header.js";
import { StatTile } from "./components/stat-tile.js";
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

export type UsersManagement = DashboardManagement<"getUserSummary" | "listUsers">;
export type UsersPageProps = {
  management: UsersManagement;
  projectName: string;
  query: { q: string; page: number };
  controls?: ReactNode;
  docsUrl: string;
  Link: DashboardLink;
  renderPagination?: (page: { page: number; pageCount: number; total: number }) => ReactNode;
};

export async function UsersPage({
  management,
  projectName,
  query,
  controls,
  docsUrl,
  Link,
  renderPagination,
}: UsersPageProps) {
  const [summary, users] = await Promise.all([
    management.getUserSummary(),
    management.listUsers({
      q: query.q || undefined,
      page: Math.min(Math.max(1, query.page), 10_000),
      perPage: 25,
    }),
  ]);
  if (users.pageCount > 0 && query.page > users.pageCount) {
    return UsersPage({
      management,
      projectName,
      query: { ...query, page: users.pageCount },
      controls,
      docsUrl,
      Link,
      renderPagination,
    });
  }
  const filtering = query.q.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Users" description={`People ${projectName} has identified through the SDK.`} />

      {summary.totalUsers === 0 && !filtering ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Users /></EmptyMedia>
            <EmptyTitle>No users yet</EmptyTitle>
            <EmptyDescription>
              Users show up here as soon as your app calls <code className="font-mono text-xs">identify()</code> through the Galinum SDK.
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatTile label="All users" value={summary.totalUsers} />
            <StatTile label="Active" value={summary.activeUsers} hint="Seen in the last 7 days" />
            <StatTile label="New" value={summary.newUsers} hint="First seen in the last 7 days" />
          </div>

          {controls && <div className="flex flex-wrap items-center gap-2">{controls}</div>}

          {users.values.length === 0 ? (
            <Card className="items-center py-12 text-sm text-muted-foreground">No users match your filters.</Card>
          ) : (
            <Card className="overflow-hidden py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">User</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Device</TableHead>
                    <TableHead className="pr-5 text-right">Last seen</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="ph-no-capture">
                  {users.values.map((user) => {
                    const label = userLabel(user.traits);
                    return (
                      <TableRow key={user.id} className="relative">
                        <TableCell className="pl-5">
                          <Link href={`/users/${user.id}`} className="before:absolute before:inset-0">
                            <span className="block max-w-56 truncate font-medium">{user.externalUserId}</span>
                            {label && label !== user.externalUserId && (
                              <span className="block max-w-56 truncate text-xs text-muted-foreground">{label}</span>
                            )}
                          </Link>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{locationLabel(user.traits) ?? "—"}</TableCell>
                        <TableCell className="text-muted-foreground">{deviceLabel(user.traits) ?? "—"}</TableCell>
                        <TableCell
                          className="pr-5 text-right text-muted-foreground"
                          title={new Date(user.lastSeenAt).toLocaleString()}
                        >
                          {relativeTime(user.lastSeenAt, summary.evaluatedAt)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
          )}

          {renderPagination?.(users)}
        </>
      )}
    </div>
  );
}
