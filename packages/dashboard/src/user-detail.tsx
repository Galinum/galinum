import type { ReactNode } from "react";
import { splitTraits, userLabel } from "@galinum/core";
import { DeliveryStateBadge } from "./components/delivery-state-badge.js";
import { dateTimeFormat } from "./date-time.js";
import type { DashboardLink, DashboardManagement } from "./dashboard-types.js";
import { PageHeader } from "./components/page-header.js";
import { relativeTime } from "./relative-time.js";
import { Card, CardContent } from "./ui/card.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table.js";

export type UserDetailManagement = DashboardManagement<
  "getUser" | "listUserEvents" | "listUserDeliveries"
>;
export type UserDetailPageProps = {
  management: UserDetailManagement;
  userId: string;
  projectName: string;
  Link: DashboardLink;
  renderCopy?: (value: string) => ReactNode;
  renderProperties?: (value: Record<string, unknown> | null) => ReactNode;
};

export async function UserDetailPage({
  management,
  userId,
  projectName,
  Link,
  renderCopy,
  renderProperties = (value) => <JsonPreview value={value} />,
}: UserDetailPageProps): Promise<ReactNode | null> {
  const user = await management.getUser(userId);
  if (!user) return null;
  const [events, deliveries] = await Promise.all([
    management.listUserEvents(user.id, { page: 1, perPage: 20 }),
    management.listUserDeliveries(user.id, { page: 1, perPage: 20 }),
  ]);
  const now = Date.now();
  const label = userLabel(user.traits);
  const { custom, auto } = splitTraits(user.traits);

  return (
    <div className="ph-no-capture flex flex-col gap-8">
      <PageHeader
        title={<span className="font-mono text-xl">{user.externalUserId}</span>}
        description={label !== user.externalUserId ? label : undefined}
      />

      <Card className="py-5">
        <CardContent className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 lg:grid-cols-4">
          <MetaField label="Project" value={projectName} />
          <MetaField label="First seen" value={dateTimeFormat.format(user.firstSeenAt)} />
          <MetaField
            label="Last seen"
            value={relativeTime(user.lastSeenAt, now)}
            title={dateTimeFormat.format(user.lastSeenAt)}
          />
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">ID</p>
            <div className="flex items-center gap-1">
              <code className="truncate font-mono text-xs text-foreground">{user.id}</code>
              {renderCopy?.(user.id)}
            </div>
          </div>
        </CardContent>
      </Card>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <TraitsCard title="Traits" traits={custom} emptyText="No traits set. Pass traits to identify() to enrich this user." />
        <TraitsCard title="Auto-collected" traits={auto} emptyText="No device or location context collected yet." />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Messages</h2>
        {deliveries.deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No campaign messages have been delivered to this user yet.</p>
        ) : (
          <Card className="overflow-hidden py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Campaign</TableHead>
                  <TableHead>Variant</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-5 text-right">Queued</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.deliveries.map((delivery) => (
                  <TableRow key={delivery.id}>
                    <TableCell className="pl-5">
                      <Link href={`/campaigns/${delivery.campaignId}`} className="font-medium hover:underline">
                        {delivery.campaignName}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{delivery.variantName}</TableCell>
                    <TableCell><DeliveryStateBadge state={delivery.state} /></TableCell>
                    <TableCell className="pr-5 text-right text-muted-foreground" title={dateTimeFormat.format(delivery.queuedAt)}>
                      {relativeTime(delivery.queuedAt, now)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Recent events</h2>
        {events.values.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events tracked for this user yet.</p>
        ) : (
          <Card className="overflow-hidden py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Event</TableHead>
                  <TableHead>Properties</TableHead>
                  <TableHead className="pr-5 text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.values.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="pl-5 font-mono text-xs font-medium">{event.name}</TableCell>
                    <TableCell className="max-w-96">{renderProperties(event.props)}</TableCell>
                    <TableCell className="pr-5 text-right text-muted-foreground" title={dateTimeFormat.format(event.ts)}>
                      {relativeTime(event.ts, now)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>
    </div>
  );
}

function MetaField({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="truncate text-sm text-foreground" title={title ?? value}>{value}</p>
    </div>
  );
}

function TraitsCard({
  title,
  traits,
  emptyText,
}: {
  title: string;
  traits: Record<string, unknown>;
  emptyText: string;
}) {
  const entries = Object.entries(traits);
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      {entries.length === 0 ? <p className="text-sm text-muted-foreground">{emptyText}</p> : (
        <Card className="overflow-hidden py-0">
          <Table>
            <TableBody>
              {entries.map(([key, value]) => (
                <TableRow key={key}>
                  <TableCell className="w-40 pl-5 font-mono text-xs text-muted-foreground">{key}</TableCell>
                  <TableCell className="pr-5 text-sm break-all">
                    {typeof value === "string" ? value : JSON.stringify(value)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function JsonPreview({ value }: { value: Record<string, unknown> | null }) {
  if (!value || Object.keys(value).length === 0) return <span className="text-muted-foreground">—</span>;
  return <code className="line-clamp-2 font-mono text-xs break-all">{JSON.stringify(value)}</code>;
}
