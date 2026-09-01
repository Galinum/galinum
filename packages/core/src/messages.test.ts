import { describe, it, expect } from "vitest";
import {
  deliveredContent,
  feedbackUpdate,
  pickVariant,
  sortByPresentation,
  type InAppMessage,
} from "./messages.js";

const variant = (id: string, weight: number) => ({
  id,
  campaign_id: "cmp_1",
  content_json: "{}",
  weight,
});

describe("pickVariant", () => {
  it("returns null when every variant is retired (weight 0)", () => {
    expect(pickVariant("eu_1", "cmp_1", [variant("var_a", 0), variant("var_b", 0)])).toBeNull();
    expect(pickVariant("eu_1", "cmp_1", [variant("var_a", -1)])).toBeNull();
  });

  it("never assigns a retired variant", () => {
    for (let i = 0; i < 50; i++) {
      const picked = pickVariant(`eu_${i}`, "cmp_1", [
        variant("var_a", 0),
        variant("var_b", 1),
        variant("var_c", 0),
      ]);
      expect(picked?.id).toBe("var_b");
    }
  });

  it("is deterministic per (user, campaign)", () => {
    const variants = [variant("var_a", 1), variant("var_b", 1)];
    const first = pickVariant("eu_1", "cmp_1", variants);
    for (let i = 0; i < 10; i++) {
      expect(pickVariant("eu_1", "cmp_1", variants)).toEqual(first);
    }
  });

  it("spreads assignment across users when weights allow", () => {
    const variants = [variant("var_a", 1), variant("var_b", 1)];
    const picked = new Set(
      Array.from({ length: 50 }, (_, i) => pickVariant(`eu_${i}`, "cmp_1", variants)?.id),
    );
    expect(picked).toEqual(new Set(["var_a", "var_b"]));
  });
});

describe("feedbackUpdate", () => {
  const NOW = 1753900000000;

  it("shown only promotes a queued delivery (never downgrades resolved states)", () => {
    expect(feedbackUpdate("shown", NOW)).toEqual({
      set: { state: "shown" },
      onlyFromState: "queued",
    });
  });

  it("resolving feedback always wins and stamps its timestamp", () => {
    expect(feedbackUpdate("clicked", NOW)).toEqual({
      set: { state: "clicked", clicked_at: NOW },
      onlyFromState: null,
    });
    expect(feedbackUpdate("dismissed", NOW)).toEqual({
      set: { state: "dismissed", dismissed_at: NOW },
      onlyFromState: null,
    });
    expect(feedbackUpdate("converted", NOW)).toEqual({
      set: { state: "converted", converted_at: NOW },
      onlyFromState: null,
    });
  });

  it("never touches shown_at (the impression stamp is exactly-once, handled separately)", () => {
    for (const type of ["shown", "clicked", "dismissed", "converted"] as const) {
      expect(Object.keys(feedbackUpdate(type, NOW).set)).not.toContain("shown_at");
    }
  });
});

describe("deliveredContent", () => {
  const MEDIA = { url: "https://media.test/a.png", alt: "A chart" };

  it("keeps an explicit presentation, even a toast with media", () => {
    expect(deliveredContent({ title: "Hi", media: MEDIA, presentation: "toast" })).toEqual({
      title: "Hi",
      media: MEDIA,
      presentation: "toast",
    });
    expect(deliveredContent({ title: "Hi", presentation: "modal" })).toEqual({
      title: "Hi",
      presentation: "modal",
    });
  });

  it("resolves legacy content from media presence", () => {
    expect(deliveredContent({ title: "Hi", media: MEDIA })).toEqual({
      title: "Hi",
      media: MEDIA,
      presentation: "modal",
    });
    expect(deliveredContent({ title: "Hi" })).toEqual({ title: "Hi", presentation: "toast" });
  });

  it("resolves an unknown stored value instead of delivering it", () => {
    expect(deliveredContent({ title: "Hi", presentation: "banner" })).toEqual({
      title: "Hi",
      presentation: "toast",
    });
  });

  it("passes non-object content through untouched", () => {
    expect(deliveredContent(null)).toBeNull();
    expect(deliveredContent("raw")).toBe("raw");
    expect(deliveredContent([{ title: "Hi" }])).toEqual([{ title: "Hi" }]);
  });
});

describe("sortByPresentation", () => {
  const msg = (deliveryId: string, presentation: string): InAppMessage => ({
    deliveryId,
    campaignId: `cmp_${deliveryId}`,
    variantId: `var_${deliveryId}`,
    content: { title: deliveryId, presentation },
  });

  it("puts modals before toasts", () => {
    const sorted = sortByPresentation([msg("a", "toast"), msg("b", "modal")]);
    expect(sorted.map((m) => m.deliveryId)).toEqual(["b", "a"]);
  });

  it("keeps campaign order within a presentation", () => {
    const sorted = sortByPresentation([
      msg("a", "toast"),
      msg("b", "modal"),
      msg("c", "toast"),
      msg("d", "modal"),
    ]);
    expect(sorted.map((m) => m.deliveryId)).toEqual(["b", "d", "a", "c"]);
  });

  it("ranks non-object content as a toast", () => {
    const custom: InAppMessage = {
      deliveryId: "x",
      campaignId: "cmp_x",
      variantId: "var_x",
      content: "raw",
    };
    const sorted = sortByPresentation([custom, msg("b", "modal")]);
    expect(sorted.map((m) => m.deliveryId)).toEqual(["b", "x"]);
  });
});
