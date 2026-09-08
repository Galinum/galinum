import { validatePushContent, validatePushSettings } from "@galinum/push";
import { destinationUrl } from "@galinum/contracts/entry";
import { canonicalizeExpression, expressionHash, isCampaignChannel, isPresentation, legacyTargetingToExpression, resolvePresentation,
  validateExpression, validatePages, validateTargeting, type CampaignChannel, type LaunchReadiness } from "@galinum/core";

export type RawCampaignDefinition = {
  pushJson?: string | null;
  name: string;
  channel: string;
  pages: string[] | null;
  deliverFrom: number | null;
  deliverUntil: number | null;
  goalId: string | null;
  audience: unknown;
  legacyTargetingJson?: string;
  variants: { id: string; name: string; contentJson: string; weight: number; isControl: boolean }[];
};
export type ReadinessAudienceReference = { id: string; segmentId: string | null; segmentVersion: number | null };
export type ReadinessAudienceVersion = ReadinessAudienceReference & {
  projectId: string;
  schemaVersion: number;
  expressionJson: string;
  expressionHash: string;
};
export type CampaignReadinessResources = {
  getGoal(projectId: string, id: string): Promise<{ projectId: string; id: string } | null>;
  getAudienceVersion(projectId: string, reference: ReadinessAudienceReference): Promise<ReadinessAudienceVersion | null>;
  getMedia(projectId: string, url: string): Promise<{ projectId: string; url: string } | null>;
  channelReadiness(projectId: string, channel: CampaignChannel): Promise<LaunchReadiness>;
};

const limits = { name: 80, variants: 10, title: 120, body: 600, alt: 300, subject: 200, previewText: 200, emailBody: 50_000 };
const unavailable = (): LaunchReadiness => ({ ok: false, error: "Campaign definition could not be verified." });
const invalid = (error: string): LaunchReadiness => ({ ok: false, error });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number, required = false): value is string => typeof value === "string" && value.length <= max && (!required || value.trim().length > 0);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;

function safeHttpUrl(value: string): boolean {
  if (!value || /[\x00-\x20\x7f\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch { return false; }
}
function safeWebUrl(value: string): boolean {
  if (!value || /[\x00-\x20\x7f\\]/.test(value)) return false;
  return (value.startsWith("/") && !value.startsWith("//")) || (value.startsWith("mailto:") && value.length > 7) || safeHttpUrl(value);
}
function audienceHash(value: unknown): { hash: string; version: number } | null {
  const checked = validateExpression(value);
  return checked.ok ? { hash: expressionHash(canonicalizeExpression(checked.expression)), version: checked.expression.version } : null;
}

function messageReadiness(channel: CampaignChannel, raw: string, mediaUrls: Set<string>): LaunchReadiness {
  let message: unknown;
  try { message = JSON.parse(raw); } catch { return invalid("Invalid message JSON."); }
  if (!object(message)) return invalid("Invalid message content.");
  if (channel === "push") return validatePushContent(message) ? { ok: true } : invalid("Invalid push content.");
  if (channel === "web_inapp") {
    if (message.title !== undefined && !text(message.title, limits.title)) return invalid("Invalid message title.");
    if (message.body !== undefined && !text(message.body, limits.body)) return invalid("Invalid message body.");
    if (!text(message.title, limits.title, true) && !text(message.body, limits.body, true)) return invalid("Message needs a title or body.");
    const presentation = message.presentation === undefined ? resolvePresentation(message) : message.presentation;
    if (!isPresentation(presentation)) return invalid("Invalid message presentation.");
  } else {
    if (["title", "presentation", "media"].some((field) => message[field] !== undefined)) return invalid("Email messages cannot contain in-app fields.");
    if (!text(message.subject, limits.subject, true) || /[\r\n\u2028\u2029]/.test(message.subject)) return invalid("Invalid email subject.");
    if (!text(message.body, limits.emailBody, true)) return invalid("Invalid email body.");
    if (message.previewText !== undefined && !text(message.previewText, limits.previewText)) return invalid("Invalid email preview text.");
  }
  if (message.cta !== undefined) {
    if (!object(message.cta) || !text(message.cta.label, Number.MAX_SAFE_INTEGER, true)) return invalid("CTA label is required.");
    const url = message.cta.url;
    if (channel === "email") { if (typeof url !== "string" || !safeHttpUrl(url)) return invalid("Invalid CTA URL."); }
    else {
      if (url !== undefined) return invalid("Use a typed CTA destination.");
      const destination = message.cta.destination;
      if (destination !== undefined) {
        if (!object(destination) || !["website", "app"].includes(String(destination.kind)) || typeof destination.url !== "string") return invalid("Invalid CTA destination.");
        if (!destinationUrl({ kind: destination.kind as "website" | "app", url: destination.url }, [destination.url.split(":")[0]])) return invalid("Invalid CTA destination.");
        try { new URL(destination.url); } catch { return invalid("Invalid CTA destination."); }
      }
    }
  }
  if (message.media !== undefined) {
    const media = message.media;
    if (!object(media) || typeof media.url !== "string" || !media.url) return invalid("Invalid campaign media.");
    if (media.alt !== undefined && !text(media.alt, limits.alt, true)) return invalid("Invalid media alt text.");
    if (media.decorative !== undefined && typeof media.decorative !== "boolean") return invalid("Invalid decorative value.");
    if (text(media.alt, limits.alt, true) === (media.decorative === true)) return invalid("Media requires alt text or decorative true.");
    mediaUrls.add(media.url);
  }
  return { ok: true };
}

async function audienceReadiness(projectId: string, definition: RawCampaignDefinition, resources: CampaignReadinessResources): Promise<LaunchReadiness> {
  const audience = definition.audience;
  if (!object(audience)) return invalid("Invalid audience.");
  if (audience.kind === "all") return { ok: true };
  if (audience.kind !== "expression" && audience.kind !== "segment") return invalid("Invalid audience.");
  const parsed = audienceHash(audience.expression);
  if (!parsed || parsed.hash !== audience.expressionHash || parsed.version !== audience.schemaVersion) return invalid("Invalid audience expression.");
  if (audience.kind === "expression" && audience.legacy === true) {
    if (audience.audienceVersionId !== null) return invalid("Invalid legacy audience reference.");
    if (definition.legacyTargetingJson !== undefined) {
      const targeting = validateTargeting(definition.legacyTargetingJson);
      if (!targeting.ok) return invalid("Invalid legacy targeting.");
      const expression = legacyTargetingToExpression(targeting.targeting);
      if (!expression || audienceHash(expression)?.hash !== parsed.hash) return invalid("Legacy targeting does not match the audience.");
    }
    return { ok: true };
  }
  if (audience.kind === "expression" && audience.legacy !== false) return invalid("Invalid audience.");
  if (!id(audience.audienceVersionId)) return invalid("Audience version is unavailable.");
  const reference: ReadinessAudienceReference = { id: audience.audienceVersionId, segmentId: null, segmentVersion: null };
  if (audience.kind === "segment") {
    if (!id(audience.segmentId) || typeof audience.segmentVersion !== "number" || !Number.isSafeInteger(audience.segmentVersion) || audience.segmentVersion <= 0) return invalid("Invalid segment reference.");
    reference.segmentId = audience.segmentId; reference.segmentVersion = audience.segmentVersion;
  }
  const version = await resources.getAudienceVersion(projectId, reference);
  if (!version || version.projectId !== projectId || version.id !== reference.id || version.segmentId !== reference.segmentId || version.segmentVersion !== reference.segmentVersion ||
    version.expressionHash !== parsed.hash || version.schemaVersion !== parsed.version) return invalid("Audience version is unavailable.");
  const stored = audienceHash(JSON.parse(version.expressionJson));
  if (!stored || stored.hash !== version.expressionHash || stored.version !== version.schemaVersion) return invalid("Invalid stored audience version.");
  return { ok: true };
}

export async function campaignDefinitionReadiness(projectId: string, definition: RawCampaignDefinition, resources: CampaignReadinessResources): Promise<LaunchReadiness> {
  try {
    if (!id(projectId) || !object(definition) || !isCampaignChannel(definition.channel)) return invalid("Unsupported campaign channel.");
    if (!text(definition.name, limits.name, true) || !validatePages(definition.pages).ok) return invalid("Invalid campaign definition.");
    if (definition.channel === "push" && !validatePushSettings(typeof definition.pushJson === "string" ? JSON.parse(definition.pushJson) : undefined)) return invalid("Invalid push settings.");
    if (["email", "push"].includes(definition.channel) && definition.pages !== null) return invalid("Email campaigns cannot contain page targeting.");
    if (definition.pages !== null && (!Array.isArray(definition.pages) || definition.pages.length === 0)) return invalid("Invalid campaign pages.");
    if (![definition.deliverFrom, definition.deliverUntil].every((value) => value === null || Number.isSafeInteger(value)) ||
      (definition.deliverFrom !== null && definition.deliverUntil !== null && definition.deliverFrom >= definition.deliverUntil)) return invalid("Invalid delivery window.");
    if (!Array.isArray(definition.variants) || definition.variants.length < 1 || definition.variants.length > limits.variants ||
      definition.variants.some((variant) => !object(variant) || !id(variant.id) || !text(variant.name, limits.name, true) || typeof variant.contentJson !== "string" ||
        !Number.isInteger(variant.weight) || variant.weight < 0 || variant.weight > 100 || typeof variant.isControl !== "boolean") ||
      !definition.variants.some((variant) => variant.weight > 0) || definition.variants.filter((variant) => variant.isControl).length > 1 ||
      new Set(definition.variants.map((variant) => variant.id)).size !== definition.variants.length) return invalid("Invalid variant allocation.");
    const mediaUrls = new Set<string>();
    for (const variant of definition.variants) {
      const result = messageReadiness(definition.channel, variant.contentJson, mediaUrls);
      if (!result.ok) return result;
    }
    for (const url of [...mediaUrls].sort()) {
      const stored = await resources.getMedia(projectId, url);
      if (!stored || stored.projectId !== projectId || stored.url !== url) return invalid("Media is unavailable in this project.");
    }
    const audience = await audienceReadiness(projectId, definition, resources);
    if (!audience.ok) return audience;
    if (definition.goalId !== null) {
      if (!id(definition.goalId)) return invalid("Invalid goal reference.");
      const goal = await resources.getGoal(projectId, definition.goalId);
      if (!goal || goal.projectId !== projectId || goal.id !== definition.goalId) return invalid("Goal not found in this project.");
    }
    const readiness = await resources.channelReadiness(projectId, definition.channel);
    if (!object(readiness) || (readiness.ok !== true && (readiness.ok !== false || !text(readiness.error, Number.MAX_SAFE_INTEGER, true)))) return unavailable();
    return readiness;
  } catch { return unavailable(); }
}
