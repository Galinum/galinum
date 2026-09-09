import type { InAppDecision } from './types.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const optional = (record: Record<string, unknown>, key: string, type: 'string' | 'boolean') => record[key] === undefined || typeof record[key] === type;

export function validInAppMessage(value: unknown): value is InAppDecision['messages'][number] {
  if (!object(value) || !['deliveryId', 'campaignId', 'variantId'].every(key => typeof value[key] === 'string' && value[key].length > 0)) return false;
  if (value.pages !== undefined && value.pages !== null && (!Array.isArray(value.pages) || !value.pages.every(page => typeof page === 'string'))) return false;
  const content = value.content;
  if (!object(content) || !optional(content, 'title', 'string') || !optional(content, 'body', 'string') || content.presentation !== undefined && content.presentation !== 'toast' && content.presentation !== 'modal') return false;
  if (content.media !== undefined) {
    if (!object(content.media) || typeof content.media.url !== 'string' || !optional(content.media, 'alt', 'string') || !optional(content.media, 'decorative', 'boolean')) return false;
    try { if (!['https:', 'http:'].includes(new URL(content.media.url).protocol)) return false; } catch { return false; }
  }
  if (content.cta !== undefined) {
    if (!object(content.cta) || typeof content.cta.label !== 'string') return false;
    const destination = content.cta.destination;
    if (destination !== undefined && (!object(destination) || !['website', 'app'].includes(String(destination.kind)) || typeof destination.kind !== 'string' || typeof destination.url !== 'string')) return false;
  }
  return true;
}
