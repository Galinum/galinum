import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compilePayload, createEncryptedVault, createPushProvider, validateCredential } from "./providers.js";
import { personalize, validatePushContent, supportsPushContent } from "./content.js";
import type { InstallationRecord } from "@galinum/core";
import type { ProtocolRequest, ProtocolResponse, PushCredential, PushEnvelope } from "./types.js";
afterEach(() => vi.restoreAllMocks());
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const apple: PushCredential = { provider: "apns", teamId: "ABCDEFGHIJ", keyId: "0123456789", topic: "com.example.app", privateKey: ec };
const google: PushCredential = { provider: "fcm", projectId: "example-project", clientEmail: "test@example-project.iam.gserviceaccount.com", privateKey: rsa };
const installation: InstallationRecord = { id: "device", appId: "com.example.app", platform: "ios", environment: "development", userId: "user", bindingGeneration: 1, revision: 3, tokenRevision: 1, token: "a".repeat(64), tokenScope: "scope", permission: "granted", consent: true, capabilities: { actions: ["open"], channels: ["updates"], categories: [{ id: "export", actions: [{ id: "open", title: "Open" }] }], richImages: true }, createdAt: 0, lastActiveAt: null, capabilityVerifier: "verifier" };
const envelope: PushEnvelope = { version: 1, targetId: "target", attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", installationId: "device", bindingGeneration: 1, test: false, content: { title: "Hello", body: "Message", destination: { kind: "app", url: "example://exports" }, actions: [{ id: "open", title: "Open" }], image: "https://example.com/image.png", ios: { subtitle: "News", sound: "default", badge: 2, categoryId: "export" }, android: { channelId: "updates" } } };
describe("direct provider protocols", () => {
  it("preserves four iOS actions and three Android actions with exact category mapping", () => {
    const actions = ["a", "b", "c", "d"].map((id) => ({ id, title: id.toUpperCase() }));
    const { android: _android, ...ios } = envelope.content;
    const iosContent = { ...ios, actions };
    const registered = { ...installation, capabilities: { ...installation.capabilities, actions: actions.map((a) => a.id), categories: [{ id: "export", actions }] } };
    expect(validatePushContent(iosContent)).toBe(true);
    expect(supportsPushContent(registered, iosContent)).toBe(true);
    expect(supportsPushContent(registered, { ...iosContent, actions: [] })).toBe(false);
    expect(JSON.parse(JSON.stringify(compilePayload({ ...envelope, content: iosContent }, "apns", 100000, null, 0).payload)).galinum.content.actions).toEqual(actions);
    expect(supportsPushContent(registered, { ...iosContent, actions: [...actions].reverse() })).toBe(false);
    expect(supportsPushContent({ ...registered, platform: "android" }, { ...envelope.content, actions })).toBe(false);
    expect(supportsPushContent({ ...registered, platform: "android" }, { ...envelope.content, actions: actions.slice(0, 3) })).toBe(true);
  });
  it("signs APNs ES256 and emits HTTP/2 rich payload headers without replacing acceptance with receipt", async () => {
    const calls: ProtocolRequest[] = [];
    const provider = createPushProvider(async (request) => { calls.push(request); return { status: 200, headers: { "apns-id": envelope.attemptId }, body: "" }; });
    expect(await provider.send(apple, installation, envelope, 100000, "replacement", 1000)).toEqual({ kind: "accepted", providerId: envelope.attemptId });
    expect(calls[0].url).toContain("api.sandbox.push.apple.com/3/device/");
    expect(calls[0].headers).toMatchObject({ "apns-topic": apple.topic, "apns-push-type": "alert", "apns-expiration": "100" });
    expect(calls[0].headers["apns-collapse-id"]).toHaveLength(64);
    const token = calls[0].headers.authorization.slice(7).split(".");
    expect(JSON.parse(Buffer.from(token[0], "base64url").toString())).toEqual({ alg: "ES256", kid: apple.keyId });
    expect(verify("sha256", Buffer.from(token.slice(0, 2).join(".")), { key: createPublicKey(ec), dsaEncoding: "ieee-p1363" }, Buffer.from(token[2], "base64url"))).toBe(true);
    const payload = JSON.parse(calls[0].body);
    expect(payload.aps).toMatchObject({ "mutable-content": 1, category: "export", badge: 2 });
    expect(payload.galinum).toEqual(envelope);
    await provider.send(apple, installation, envelope, 100000, null, 2000);
    expect(calls[1].headers.authorization).toBe(calls[0].headers.authorization);
  });
  it("exchanges an RS256 service-account assertion and sends action-preserving FCM data", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const calls: ProtocolRequest[] = [];
    const provider = createPushProvider(async (request) => {
      calls.push(request);
      return request.url.includes("oauth2") ? { status: 200, headers: {}, body: JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }) } : { status: 200, headers: {}, body: JSON.stringify({ name: "projects/example/messages/provider-id" }) };
    });
    const result = await provider.send(google, { ...installation, platform: "android" }, envelope, 100000, "replace", 1000);
    expect(result.kind).toBe("accepted");
    const assertion = new URLSearchParams(calls[0].body).get("assertion")!.split(".");
    expect(verify("sha256", Buffer.from(assertion.slice(0, 2).join(".")), createPublicKey(rsa), Buffer.from(assertion[2], "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(assertion[1], "base64url").toString()).scope).toBe("https://www.googleapis.com/auth/firebase.messaging");
    const message = JSON.parse(calls[1].body).message;
    expect(message.notification).toBeUndefined();
    expect(JSON.parse(message.data.galinum)).toEqual(envelope);
    expect(message.android).toMatchObject({ priority: "HIGH", ttl: "99s" });
    expect(calls[1].headers.authorization).toBe("Bearer test-access-token");
  });
  it("separates invalid tokens, throttles and unknown submissions", async () => {
    const invalid = createPushProvider(async () => ({ status: 410, headers: {}, body: '{"reason":"Unregistered"}' }));
    expect(await invalid.send(apple, installation, envelope, 100000, null, 1000)).toEqual({ kind: "rejected", code: "invalid_token" });
    const throttle = createPushProvider(async () => ({ status: 429, headers: { "retry-after": "90" }, body: "{}" }));
    expect(await throttle.send(apple, installation, envelope, 100000, null, 1000)).toMatchObject({ code: "transient", retryAfterMs: 90000 });
    const uncertain = createPushProvider(async () => { throw new Error("connection reset"); });
    expect(await uncertain.send(apple, installation, envelope, 100000, null, 1000)).toEqual({ kind: "unknown", code: "transport" });
    expect(() => compilePayload({ ...envelope, content: { ...envelope.content, body: "😀".repeat(2000) } }, "apns", 100000, null, 1000)).toThrow("4096");
  });
  it("encrypts and scopes credentials, validates key types, and renders only supported templates", () => {
    const vault = createEncryptedVault(Buffer.alloc(32, 4).toString("base64"));
    const encrypted = vault.seal(apple, "project:credential");
    expect(encrypted).not.toContain("PRIVATE KEY");
    expect(vault.open(encrypted, "project:credential")).toEqual(apple);
    expect(() => vault.open(encrypted, "other:credential")).toThrow("unavailable");
    expect(() => validateCredential({ ...apple, privateKey: rsa })).toThrow("Invalid push credential");
    expect(personalize({ ...envelope.content, title: '{{ user.name | default: "Hello" }}' }, {}).title).toBe("Hello");
    expect(() => personalize({ ...envelope.content, title: "{{ user.missing }}" }, {})).toThrow("Missing");
    expect(validatePushContent({ ...envelope.content, destination: { kind: "website", url: "javascript:alert(1)" } })).toBe(false);
    expect(validatePushContent({ ...envelope.content, actions: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }, { id: "d", title: "D" }, { id: "e", title: "E" }] })).toBe(false);
  });
});


it.each([apple, google])("refreshes rejected cached auth once per caller invocation for $provider", async (credential) => {
  const calls: ProtocolRequest[] = []; let reject = false; let exchange = 0;
  const provider = createPushProvider(async (request): Promise<ProtocolResponse> => {
    calls.push(request);
    if (request.url.includes("oauth2")) return { status: 200, headers: {}, body: JSON.stringify({ access_token: `access-${++exchange}`, expires_in: 3600 }) };
    return reject ? { status: credential.provider === "apns" ? 403 : 401, headers: {}, body: '{"reason":"ExpiredProviderToken"}' } : { status: 200, headers: { "apns-id": envelope.attemptId }, body: '{"name":"message"}' };
  });
  expect((await provider.send(credential, installation, envelope, 100000, null, 1000)).kind).toBe("accepted");
  reject = true;
  expect(await provider.send(credential, installation, envelope, 100000, null, 2000)).toMatchObject({ code: "auth_refresh" });
  expect(calls.filter((r) => !r.url.includes("oauth2"))).toHaveLength(2);
  expect(await provider.send(credential, installation, envelope, 100000, null, 3000)).toMatchObject({ code: "credential" });
  expect(calls.filter((r) => !r.url.includes("oauth2"))).toHaveLength(3);
  if (credential.provider === "fcm") expect(exchange).toBe(2);
});

it("cancels one total budget across OAuth and notification and awaits transport settlement", async () => {
  vi.useFakeTimers();
  try {
    const calls: ProtocolRequest[] = []; let settled = false;
    const provider = createPushProvider(async (request) => {
      calls.push(request);
      if (request.url.includes("oauth2")) {
        await new Promise((resolve) => setTimeout(resolve, 6000));
        return { status: 200, headers: {}, body: '{"access_token":"token","expires_in":3600}' };
      }
      return new Promise((_resolve, reject) => request.signal!.addEventListener("abort", () => {
        setTimeout(() => { settled = true; reject(new Error("cancelled")); }, 25);
      }, { once: true }));
    });
    let done = false;
    const pending = provider.send(google, installation, envelope, 100000, null, 0).then((result) => { done = true; return result; });
    await vi.advanceTimersByTimeAsync(9999);
    expect(calls).toHaveLength(2); expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls[1].signal!.aborted).toBe(true); expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toMatchObject({ kind: "unknown" }); expect(settled).toBe(true);
  } finally { vi.useRealTimers(); }
});

it.each([2000, 10000])("boundary: OAuth delay respects absolute expiry and remaining TTL (%i ms)", async (remaining) => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  try {
    const requests: ProtocolRequest[] = [];
    const provider = createPushProvider(async (request) => {
      requests.push(request);
      if (request.url.includes("oauth2")) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return { status: 200, headers: {}, body: '{"access_token":"fixture","expires_in":3600}' };
      }
      return { status: 200, headers: {}, body: '{"name":"fixture-message"}' };
    });
    const pending = provider.send(google, installation, envelope, 1000 + remaining, null, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    const outcome = await pending;
    if (remaining === 2000) {
      expect(requests).toHaveLength(1);
      expect(outcome).toMatchObject({ kind: "blocked", code: "expired", messageAttempted: false });
    } else {
      expect(requests).toHaveLength(2);
      expect(JSON.parse(requests[1].body).message.android.ttl).toBe("7s");
      expect(outcome.kind).toBe("accepted");
    }
    provider.close?.();
  } finally { vi.useRealTimers(); }
});
