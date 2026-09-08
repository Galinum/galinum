import { validateSchema, installationSchemas } from "@galinum/contracts";
import type { InstallationRecord } from "@galinum/core";
import type { PushContent, PushSettings } from "./types.js";
function url(value: unknown, website = false) { try { const parsed = new URL(String(value)); return !parsed.username && !parsed.password && (website ? parsed.protocol === "https:" : ["https:", "http:"].includes(parsed.protocol) || /^[a-z][a-z0-9+.-]*:$/.test(parsed.protocol) && !["javascript:", "data:", "file:"].includes(parsed.protocol)); } catch { return false; } }
export function validatePushContent(value: unknown): value is PushContent {
  if (!validateSchema(installationSchemas.PushContent, value, installationSchemas)) return false;
  const p = value as PushContent;
  return (!p.android || (p.actions?.length ?? 0) <= 3) && url(p.destination.url, p.destination.kind === "website") && (p.image === undefined || url(p.image, true))
    && Object.keys(p.data ?? {}).every((key) => !key.toLowerCase().startsWith("galinum"))
    && new Set((p.actions ?? []).map((action) => action.id)).size === (p.actions ?? []).length;
}
export function validatePushSettings(value: unknown): value is PushSettings { return validateSchema(installationSchemas.PushSettings, value, installationSchemas); }
export function personalize(content: PushContent, traits: Record<string, unknown>): PushContent {
  const render = (value: string) => value.replace(/{{(.*?)}}/g, (_, expression: string) => {
    const match = /^\s*user\.([A-Za-z0-9_$.-]+)(?:\s*\|\s*default:\s*("(?:[^"\\]|\\.)*"))?\s*$/.exec(expression);
    if (!match) throw new Error("Invalid personalization");
    const field = traits[match[1]];
    if (typeof field === "string" || typeof field === "number" || typeof field === "boolean") return String(field);
    if (match[2]) return JSON.parse(match[2]) as string;
    throw new Error("Missing personalization value");
  });
  const result = { ...content, title: render(content.title), body: render(content.body), ...(content.ios ? { ios: { ...content.ios, ...(content.ios.subtitle ? { subtitle: render(content.ios.subtitle) } : {}) } } : {}), ...(content.actions ? { actions: content.actions.map((action) => ({ ...action, title: render(action.title) })) } : {}) };
  if ([result.title, result.body, result.ios?.subtitle ?? "", ...(result.actions ?? []).map((a) => a.title)].some((text) => text.includes("{{") || text.includes("}}"))) throw new Error("Invalid personalization");
  if (!validatePushContent(result)) throw new Error("Invalid personalized payload");
  return result;
}

export function supportsPushContent(installation: InstallationRecord, content: PushContent): boolean {
  const actions = content.actions ?? [];
  if (content.image && !installation.capabilities.richImages) return false;
  if (actions.some((action) => !installation.capabilities.actions.includes(action.id))) return false;
  if (installation.platform === "android") return actions.length <= 3 && !!content.android && installation.capabilities.channels.includes(content.android.channelId);
  if (!content.ios?.categoryId) return actions.length === 0;
  const category = installation.capabilities.categories?.find((entry) => entry.id === content.ios?.categoryId);
  return actions.length <= 4 && !!category && category.actions.length === actions.length && actions.every((action, index) => category.actions[index].id === action.id && category.actions[index].title === action.title);
}
