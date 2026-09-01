import { describe, expect, it } from "vitest";
import { serverConfig } from "./server-config.js";

describe("server configuration", () => {
  it("defaults memory media to the listening localhost origin", () => {
    expect(serverConfig({ PORT: "4321" })).toEqual({
      host: "127.0.0.1",
      port: 4321,
      mediaDirectory: null,
      publicOrigin: "http://localhost:4321",
      warning: "GALINUM_PUBLIC_URL is unset; media URLs default to http://localhost:4321",
    });
  });

  it("requires an explicit origin for persistent media", () => {
    expect(() => serverConfig({ GALINUM_MEDIA_DIR: "/data/media" })).toThrow("GALINUM_PUBLIC_URL is required");
    expect(serverConfig({
      GALINUM_HOST: "0.0.0.0",
      PORT: "3000",
      GALINUM_MEDIA_DIR: "/data/media",
      GALINUM_PUBLIC_URL: "https://galinum.example",
    })).toMatchObject({
      host: "0.0.0.0",
      port: 3000,
      mediaDirectory: "/data/media",
      publicOrigin: "https://galinum.example",
      warning: null,
    });
  });

  it("rejects port zero and invalid public URLs", () => {
    expect(() => serverConfig({ GALINUM_HOST: "bad host" })).toThrow("hostname or IP address");
    expect(() => serverConfig({ PORT: "0" })).toThrow("PORT must be an integer from 1 to 65535");
    expect(() => serverConfig({ GALINUM_PUBLIC_URL: "https://example.com/path" })).toThrow("origin-only HTTP(S) URL");
  });
});
