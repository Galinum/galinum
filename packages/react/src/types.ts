export type Traits = Record<string, unknown>;
export type EventProps = Record<string, unknown>;

// `shown` is the impression: the SDK reports it when a message actually
// renders (not when /messages returns it). The rest resolve the delivery.
export type DeliveryFeedback = "shown" | "clicked" | "dismissed" | "converted";

// One optional image (PNG, JPEG, WebP, or animated GIF). Media is content, not
// presentation: a toast shows it as a compact thumbnail and a modal shows it
// as the immersive visual. `alt` describes the image for assistive tech;
// `decorative: true` marks it as purely visual instead (exactly one applies).
export type MessageMedia = {
  url: string;
  alt?: string;
  decorative?: boolean;
};

// How the built-in renderer presents a message.
export type MessagePresentation = "toast" | "modal";

// Default content shape rendered by the built-in <InAppMessages/> renderer.
// Pass a custom `render` to handle richer campaign content.
export type MessageContent = {
  title?: string;
  body?: string;
  cta?: { label: string; url?: string };
  media?: MessageMedia;
  // Delivered messages always carry this; older stored campaigns resolve to
  // modal with media and toast without it.
  presentation?: MessagePresentation;
  [key: string]: unknown;
};

export type InAppMessage = {
  deliveryId: string;
  campaignId: string;
  variantId: string;
  content: MessageContent;
  // Path patterns this message may render on; null/absent = every page.
  // Present only when the server honors the `pages` capability.
  pages?: string[] | null;
};

export type GalinumConfig = {
  publishableKey: string;
  apiBase: string;
};
