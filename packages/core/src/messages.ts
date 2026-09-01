import { createHash } from "node:crypto";
import { resolvePresentation } from "./presentation.js";

export type InAppMessage = {
  deliveryId: string;
  campaignId: string;
  variantId: string;
  content: unknown;
  pages?: string[] | null;
};

export type VariantAssignment = {
  id: string;
  campaign_id: string;
  content_json: string;
  weight: number;
};

export function pickVariant(
  endUserId: string,
  campaignId: string,
  variants: VariantAssignment[],
): VariantAssignment | null {
  const total = variants.reduce((sum, variant) => sum + Math.max(0, variant.weight), 0);
  if (total <= 0) return null;
  const point = createHash("sha256").update(`${endUserId}:${campaignId}`).digest().readUInt32BE(0) % total;
  let accumulated = 0;
  for (const variant of variants) {
    accumulated += Math.max(0, variant.weight);
    if (point < accumulated) return variant;
  }
  return variants[variants.length - 1];
}

export function sortByPresentation(messages: InAppMessage[]): InAppMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const rank = presentationRank(left.message) - presentationRank(right.message);
      return rank !== 0 ? rank : left.index - right.index;
    })
    .map((entry) => entry.message);
}

function presentationRank(message: InAppMessage): number {
  const content = message.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) return 1;
  return (content as { presentation?: unknown }).presentation === "modal" ? 0 : 1;
}

export type DeliveryFeedback = "shown" | "clicked" | "dismissed" | "converted";
type ResolvingFeedback = Exclude<DeliveryFeedback, "shown">;

const feedbackColumn: Record<ResolvingFeedback, "clicked_at" | "dismissed_at" | "converted_at"> = {
  clicked: "clicked_at",
  dismissed: "dismissed_at",
  converted: "converted_at",
};

export function feedbackUpdate(
  type: DeliveryFeedback,
  now: number,
): { set: Record<string, string | number>; onlyFromState: string | null } {
  if (type === "shown") return { set: { state: "shown" }, onlyFromState: "queued" };
  return { set: { state: type, [feedbackColumn[type]]: now }, onlyFromState: null };
}

export function deliveredContent(content: unknown): unknown {
  if (!content || typeof content !== "object" || Array.isArray(content)) return content;
  return { ...content, presentation: resolvePresentation(content) };
}
