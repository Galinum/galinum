import { describe, expect, it } from "vitest";
import { CAMPAIGN_CHANNELS, CHANNELS, isCampaignChannel } from "./channels.js";

describe("channel exposure semantics", () => {
  it("keeps one exposure column per channel", () => {
    expect(CHANNELS.web_inapp.exposureColumn).toBe("shown_at");
    expect(CHANNELS.email.exposureColumn).toBe("delivered_at");
  });

  it("derives runtime channel validation from the registry", () => {
    expect(CAMPAIGN_CHANNELS).toEqual(Object.keys(CHANNELS));
    expect(isCampaignChannel("web_inapp")).toBe(true);
    expect(isCampaignChannel("email")).toBe(true);
    expect(isCampaignChannel("push")).toBe(false);
  });
});
