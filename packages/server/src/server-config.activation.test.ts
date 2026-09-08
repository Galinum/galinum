import { describe, expect, it } from "vitest";
import { serverConfig } from "./server-config.js";

describe("stock activation environment", () => {
  it("requires a complete explicit GitHub App profile", () => {
    expect(() => serverConfig({ GALINUM_GITHUB_APP_ID: "1" })).toThrow("configured together");
    expect(() => serverConfig({ GALINUM_GITHUB_APP_ID: "bad", GALINUM_GITHUB_CLIENT_ID: "Iv.test", GALINUM_GITHUB_PRIVATE_KEY: "fixture" })).toThrow("APP_ID");
    expect(serverConfig({ GALINUM_GITHUB_APP_ID: "1", GALINUM_GITHUB_CLIENT_ID: "Iv.test", GALINUM_GITHUB_PRIVATE_KEY: "fixture", GALINUM_OPERATOR_KEY: "operator" })).toMatchObject({
      github: { appId: 1, clientId: "Iv.test", privateKey: "fixture" }, operatorKey: "operator",
    });
  });
  it("does not derive an operator credential from management credentials", () => {
    expect(serverConfig({ GALINUM_SECRET_KEY: "management", GALINUM_PUBLISHABLE_KEY: "publishable" }).operatorKey).toBeUndefined();
  });
});
