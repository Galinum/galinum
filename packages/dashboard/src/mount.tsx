import type { DashboardSession } from "@galinum/core/contract";
import { AgentRunsPage, type AgentRunsPageProps } from "./agent-runs.js";
import { CampaignDetailPage, type CampaignDetailPageProps } from "./campaign-detail.js";
import { CampaignsPage, type CampaignsPageProps } from "./campaigns.js";
import type { DashboardLink } from "./dashboard-types.js";
import { EventsPage, type EventsPageProps } from "./events.js";
import { HomePage } from "./home.js";
import { MetricsPage, type MetricsPageProps } from "./metrics.js";
import { UserDetailPage, type UserDetailPageProps } from "./user-detail.js";
import { UsersPage, type UsersPageProps } from "./users.js";

type MountedMetrics = Omit<MetricsPageProps, "management">;
type MountedUsers = Omit<UsersPageProps, "management" | "projectName" | "docsUrl" | "Link">;
type MountedUser = Omit<UserDetailPageProps, "management" | "projectName" | "Link">;
type MountedEvents = Omit<EventsPageProps, "management" | "projectName" | "docsUrl" | "Link">;
type MountedCampaigns = Omit<CampaignsPageProps, "management" | "docsUrl" | "Link">;
type MountedCampaign = Omit<CampaignDetailPageProps, "management" | "projectName" | "Link">;
type MountedAgentRuns = Omit<AgentRunsPageProps, "management" | "projectName" | "docsUrl" | "Link">;

export function createDashboard({
  open,
  Link,
  docsUrl,
  campaignDocsUrl = docsUrl,
}: {
  open: () => Promise<DashboardSession>;
  Link: DashboardLink;
  docsUrl: string;
  campaignDocsUrl?: string;
}) {
  return {
    pages: {
      async home() {
        return HomePage({ session: await open() });
      },
      async metrics(input: MountedMetrics) {
        const session = await open();
        return MetricsPage({ management: session.management, ...input });
      },
      async users(input: MountedUsers) {
        const session = await open();
        return UsersPage({
          management: session.management,
          projectName: session.project.name,
          docsUrl,
          Link,
          ...input,
        });
      },
      async user(input: MountedUser) {
        const session = await open();
        return UserDetailPage({
          management: session.management,
          projectName: session.project.name,
          Link,
          ...input,
        });
      },
      async events(input: MountedEvents) {
        const session = await open();
        return EventsPage({
          management: session.management,
          projectName: session.project.name,
          docsUrl,
          Link,
          ...input,
        });
      },
      async campaigns(input: MountedCampaigns) {
        const session = await open();
        return CampaignsPage({
          management: session.management,
          docsUrl: campaignDocsUrl,
          Link,
          ...input,
        });
      },
      async campaign(input: MountedCampaign) {
        const session = await open();
        return CampaignDetailPage({
          management: session.management,
          projectName: session.project.name,
          Link,
          ...input,
        });
      },
      async agentRuns(input: MountedAgentRuns) {
        const session = await open();
        return AgentRunsPage({
          management: session.management,
          projectName: session.project.name,
          docsUrl,
          Link,
          ...input,
        });
      },
    },
  };
}
