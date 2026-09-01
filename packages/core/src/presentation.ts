// How the SDK's default renderer presents a message. Separate from
// campaigns.ts so client components can resolve it without pulling in the
// database client.
export const PRESENTATIONS = ["toast", "modal"] as const;
export type MessagePresentation = (typeof PRESENTATIONS)[number];

export const PRESENTATION_REQUIRED_ERROR =
  'message.presentation is required: "toast" or "modal"';

export const PRESENTATION_INVALID_ERROR = 'message.presentation must be "toast" or "modal"';

export function isPresentation(value: unknown): value is MessagePresentation {
  return typeof value === "string" && (PRESENTATIONS as readonly string[]).includes(value);
}

// Single source of truth for content with no usable stored presentation:
// Campaigns saved before explicit presentation keep the media-driven layout.
export function resolvePresentation(content: {
  media?: unknown;
  presentation?: unknown;
}): MessagePresentation {
  if (isPresentation(content.presentation)) return content.presentation;
  return content.media ? "modal" : "toast";
}
