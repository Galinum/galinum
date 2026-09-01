import type { DashboardSession } from "@galinum/core/contract";
import type { DashboardManagement } from "./dashboard-types.js";
import { ActivityList, type ActivityItem } from "./components/activity-list.js";
import { Greeting } from "./components/greeting.js";
import { StatTile } from "./components/stat-tile.js";
import { relativeTime } from "./relative-time.js";

export type HomeSession = Omit<DashboardSession, "management"> & {
  management: DashboardManagement<"getOverview" | "listActivity">;
};
export type HomePageProps = { session: HomeSession };

export async function HomePage({ session }: HomePageProps) {
  const [overview, activity] = await Promise.all([
    session.management.getOverview(),
    session.management.listActivity({ limit: 10 }),
  ]);
  const firstName = session.viewer.name.trim().split(/\s+/)[0] ?? "";
  const items: ActivityItem[] = activity.items.map((item) => item.kind === "delivery"
    ? {
        id: "delivery-" + item.id,
        kind: item.kind,
        title: `Message queued for ${item.user.externalUserId}`,
        detail: `${item.campaign.name} · ${item.variant.name}`,
        when: relativeTime(item.occurredAt, activity.evaluatedAt),
      }
    : {
        id: "user-" + item.id,
        kind: item.kind,
        title: `New user ${item.user.externalUserId}`,
        detail: session.project.name,
        when: relativeTime(item.occurredAt, activity.evaluatedAt),
      });

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">
          <Greeting firstName={firstName} />
        </h1>
        <p className="text-sm text-muted-foreground">
          Here&apos;s what&apos;s happening in {session.project.name}.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="End users" value={overview.endUsers} hint={session.project.name} />
        <StatTile label="Events" value={overview.eventsLast7d} hint="Last 7 days" />
        <StatTile label="Active campaigns" value={overview.activeCampaigns} hint="Running now" />
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-foreground">Recent activity</h2>
        <ActivityList items={items} />
      </section>
    </div>
  );
}
