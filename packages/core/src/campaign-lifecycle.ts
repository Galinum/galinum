import type { LaunchReadiness } from "./campaign-effects.js";

export type CampaignLifecycleStatus = "draft" | "running" | "paused" | "ended";
export type CampaignLifecycleAction = "launch" | "pause" | "end";
export type CampaignLifecycleCommand = { action: "launch"; readiness: LaunchReadiness; initialOnly?: boolean } | { action: "pause" | "end" };
export type CampaignLifecycle = { status: CampaignLifecycleStatus; startedAt: number | null; endedAt: number | null };
export type CampaignLifecycleInput = CampaignLifecycle & { deliverUntil: number | null };
export type CampaignLifecyclePlan = { ok: true; lifecycle: CampaignLifecycle; initial: boolean } | { ok: false; error: string };

export function planCampaignLifecycle(
  campaign: CampaignLifecycleInput,
  command: CampaignLifecycleCommand,
  now: number,
): CampaignLifecyclePlan {
  const action = command?.action;
  if (!Number.isFinite(now)) return { ok: false, error: "The current time is invalid." };
  if (!["draft", "running", "paused", "ended"].includes(campaign.status)) return { ok: false, error: "The campaign status is invalid." };
  if (command.action === "launch" && command.initialOnly && (campaign.status !== "draft" || campaign.startedAt !== null)) {
    return { ok: false, error: "Only an unlaunched draft can be activated automatically." };
  }
  if (campaign.status === "ended") return { ok: false, error: "This campaign has ended." };
  if (action !== "end" && campaign.deliverUntil !== null &&
    (!Number.isFinite(campaign.deliverUntil) || now >= campaign.deliverUntil)) {
    return { ok: false, error: "This campaign's delivery window has passed. Extend deliverUntil to resume delivery, or end the campaign." };
  }
  if (command.action === "launch") {
    if (command.readiness?.ok !== true) return { ok: false, error: command.readiness?.error ?? "Launch readiness has not been verified." };
    if (campaign.status === "running") return { ok: false, error: "Campaign is already running." };
    return { ok: true, initial: campaign.startedAt === null,
      lifecycle: { status: "running", startedAt: campaign.startedAt ?? now, endedAt: campaign.endedAt } };
  }
  if (action === "pause") {
    if (campaign.status !== "running") return { ok: false, error: "Only running campaigns can be paused." };
    return { ok: true, initial: false, lifecycle: { status: "paused", startedAt: campaign.startedAt, endedAt: campaign.endedAt } };
  }
  if (action === "end") return { ok: true, initial: false, lifecycle: { status: "ended", startedAt: campaign.startedAt, endedAt: now } };
  return { ok: false, error: "Unknown campaign action." };
}
