import type { CampaignDeliveryState } from "@galinum/core/contract";

const stateStyles: Record<CampaignDeliveryState, string> = {
  queued: "border border-border text-muted-foreground",
  sending: "bg-secondary text-secondary-foreground",
  retryable: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  frequency_capped: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  sent: "bg-secondary text-secondary-foreground",
  delivered: "bg-primary/10 text-primary",
  shown: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  opened: "bg-primary/10 text-primary",
  clicked: "bg-primary/10 text-primary",
  dismissed: "bg-muted text-muted-foreground",
  bounced: "bg-destructive/10 text-destructive",
  complained: "bg-destructive/10 text-destructive",
  unsubscribed: "bg-muted text-muted-foreground",
  failed: "bg-destructive/10 text-destructive",
  converted: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
};

export function DeliveryStateBadge({ state }: { state: CampaignDeliveryState }) {
  return (
    <span className={`inline-flex h-5 shrink-0 items-center rounded-4xl px-2 text-xs font-medium capitalize ${stateStyles[state]}`}>
      {state.replaceAll("_", " ")}
    </span>
  );
}
