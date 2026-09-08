import { validateSchema, installationSchemas } from "@galinum/contracts";
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";
import type { CredentialVault, ProtocolTransport, PushCredential, PushProvider, PushEnvelope, ProtocolRequest, ProviderOutcome } from "./types.js";

export function validateCredential(value: unknown): PushCredential {
  if (!validateSchema(installationSchemas.PushCredential, value, installationSchemas)) throw new Error("Invalid push credential");
  const credential = value as PushCredential;
  try {
    if (typeof credential.privateKey !== "string" || credential.privateKey.length > 16384) throw new Error();
    const key = createPrivateKey(credential.privateKey);
    if (credential.provider === "apns") {
      if (!/^[A-Z0-9]{10}$/.test(credential.teamId) || !/^[A-Z0-9]{10}$/.test(credential.keyId) || !/^[A-Za-z0-9.-]{1,256}$/.test(credential.topic) || key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
    } else if (credential.provider === "fcm") {
      if (!/^[a-z][a-z0-9-]{4,62}$/.test(credential.projectId) || !/^[^\s@]+@[^\s@]+$/.test(credential.clientEmail) || key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error();
    } else throw new Error();
    return credential;
  } catch { throw new Error("Invalid push credential"); }
}
export function createEncryptedVault(encodedKey: string): CredentialVault {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) throw new Error("Push encryption key must encode 32 bytes");
  return {
    seal(credential, scope) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(scope));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(credential)), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
    },
    open(encrypted, scope) {
      try {
        const bytes = Buffer.from(encrypted, "base64");
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
        decipher.setAAD(Buffer.from(scope)); decipher.setAuthTag(bytes.subarray(12, 28));
        return validateCredential(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()));
      } catch { throw new Error("Push credential unavailable"); }
    },
  };
}
function jwt(header: object, claims: object, privateKey: string, algorithm: "ES256" | "RS256") {
  const input = [header, claims].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
  const signature = sign("sha256", Buffer.from(input), algorithm === "ES256" ? { key: privateKey, dsaEncoding: "ieee-p1363" } : privateKey);
  return `${input}.${signature.toString("base64url")}`;
}
export function createProtocolTransport(): { transport: ProtocolTransport; close(): void } {
  const sessions = new Map<string, ClientHttp2Session>();
  const transport: ProtocolTransport = async (request) => {
    if (request.protocol === "https") {
      const response = await fetch(request.url, { method: "POST", headers: request.headers, body: request.body, signal: request.signal, redirect: "error" });
      const body = await response.text();
      if (Buffer.byteLength(body) > 65536) throw new Error("Provider response too large");
      return { status: response.status, headers: Object.fromEntries(response.headers), body };
    }
    request.signal?.throwIfAborted();
    const url = new URL(request.url);
    let session = sessions.get(url.origin);
    if (!session || session.destroyed || session.closed) {
      session = connect(url.origin);
      sessions.set(url.origin, session);
      session.on("error", () => { session?.destroy(); });
      session.on("goaway", () => { session?.close(); });
    }
    const active = session;
    return new Promise((resolve, reject) => {
      const stream = active.request({ ":method": "POST", ":path": url.pathname, ...request.headers });
      let status = 0; let headers: Record<string, string> = {}; let body = "";
      stream.setEncoding("utf8");
      const abort = () => stream.destroy(new Error("Provider timeout"));
      request.signal?.addEventListener("abort", abort, { once: true });
      stream.on("close", () => request.signal?.removeEventListener("abort", abort));
      if (request.signal?.aborted) abort();
      stream.on("response", (response) => { status = Number(response[":status"]); headers = Object.fromEntries(Object.entries(response).map(([name, value]) => [name, String(value)])); });
      stream.on("data", (chunk) => { body += chunk; if (Buffer.byteLength(body) > 65536) stream.destroy(new Error("Provider response too large")); });
      let failure: Error | null = null; let ended = false;
      stream.on("error", (error) => { failure = error; });
      stream.on("end", () => { ended = true; });
      stream.on("close", () => failure || !ended ? reject(failure ?? new Error("Provider stream closed")) : resolve({ status, headers, body }));
      stream.end(request.body);
    });
  };
  return { transport, close() { for (const session of sessions.values()) session.destroy(); sessions.clear(); } };
}
export function compilePayload(envelope: PushEnvelope, provider: "apns" | "fcm", expiresAt: number, replacementKey: string | null, now: number) {
  const content = envelope.content;
  const collapse = replacementKey === null ? undefined : createHash("sha256").update(replacementKey).digest("hex");
  const payload = provider === "apns" ? {
    aps: { alert: { title: content.title, body: content.body, ...(content.ios?.subtitle ? { subtitle: content.ios.subtitle } : {}) }, ...(content.image ? { "mutable-content": 1 } : {}), ...(content.ios?.sound ? { sound: content.ios.sound } : {}), ...(content.ios?.badge !== undefined ? { badge: content.ios.badge } : {}), ...(content.ios?.categoryId ? { category: content.ios.categoryId } : {}) },
    galinum: envelope,
  } : { data: { galinum: JSON.stringify(envelope) }, android: { priority: "HIGH", ttl: `${Math.max(0, Math.floor((expiresAt - now) / 1000))}s`, ...(collapse ? { collapse_key: collapse } : {}) } };
  if (Buffer.byteLength(JSON.stringify(payload)) > 4096) throw new Error("Push payload exceeds 4096 bytes");
  return { payload, collapse };
}
export function createPushProvider(injected?: ProtocolTransport): PushProvider {
  const native = injected ? null : createProtocolTransport();
  const transport = injected ?? native!.transport;
  const tokens = new Map<string, { token: string; expiresAt: number }>();
  return {
    async send(credential, installation, envelope, expiresAt, replacementKey, now) {
      const startedAt = performance.now();
      const currentTime = () => now + Math.max(0, performance.now() - startedAt);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const invoke: ProtocolTransport = (request) => { controller.signal.throwIfAborted(); return transport({ ...request, signal: controller.signal }); };
      try {
      try { validateCredential(credential); } catch { return { kind: "rejected", code: "credential", messageAttempted: false }; }
      let compiled: ReturnType<typeof compilePayload>;
      try { compiled = compilePayload(envelope, credential.provider, expiresAt, replacementKey, now); }
      catch { return { kind: "rejected", code: "payload", messageAttempted: false }; }
      const key = createHash("sha256").update(JSON.stringify(credential)).digest("hex");
      let auth = tokens.get(key);
      const cached = !!auth && auth.expiresAt > now;
      try {
        if (!auth || auth.expiresAt <= now) {
          if (credential.provider === "apns") auth = { token: jwt({ alg: "ES256", kid: credential.keyId }, { iss: credential.teamId, iat: Math.floor(now / 1000) }, credential.privateKey, "ES256"), expiresAt: now + 3000000 };
          else {
            const assertion = jwt({ alg: "RS256", typ: "JWT" }, { iss: credential.clientEmail, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600 }, credential.privateKey, "RS256");
            const response = await invoke({ protocol: "https", url: "https://oauth2.googleapis.com/token", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() });
            const data = JSON.parse(response.body);
            if (response.status >= 500 || response.status === 429) return { kind: "rejected", code: "transient", retryAfterMs: 60000, messageAttempted: false };
            if (response.status !== 200 || typeof data.access_token !== "string") return { kind: "rejected", code: "credential", messageAttempted: false };
            auth = { token: data.access_token, expiresAt: now + Math.max(0, Math.min(Number(data.expires_in) || 3600, 3600) - 60) * 1000 };
          }
          tokens.set(key, auth);
        }
      } catch { return { kind: "rejected", code: "transient", retryAfterMs: 60000, messageAttempted: false }; }
      const messageAt = currentTime();
      if (messageAt >= expiresAt) return { kind: "blocked", code: "expired", messageAttempted: false };
      if (controller.signal.aborted) return { kind: "rejected", code: "transient", messageAttempted: false };
      compiled = compilePayload(envelope, credential.provider, expiresAt, replacementKey, messageAt);
      const request: ProtocolRequest = credential.provider === "apns" ? {
        protocol: "http2", url: `https://${installation.environment === "development" ? "api.sandbox.push.apple.com" : "api.push.apple.com"}/3/device/${encodeURIComponent(installation.token!)}`,
        headers: { "content-type": "application/json", authorization: `bearer ${auth.token}`, "apns-topic": credential.topic, "apns-push-type": "alert", "apns-priority": "10", "apns-id": envelope.attemptId, "apns-expiration": String(Math.floor(expiresAt / 1000)), ...(compiled.collapse ? { "apns-collapse-id": compiled.collapse } : {}) }, body: JSON.stringify(compiled.payload),
      } : { protocol: "https", url: `https://fcm.googleapis.com/v1/projects/${credential.projectId}/messages:send`, headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" }, body: JSON.stringify({ message: { token: installation.token, ...compiled.payload } }) };
      try {
        const response = await invoke(request);
        let data: { name?: string; reason?: string; error?: { details?: { "@type"?: string; errorCode?: string }[] } } = {};
        try { data = response.body ? JSON.parse(response.body) : {}; } catch {}
        if (response.status === 200) {
          const providerId = credential.provider === "apns" ? response.headers["apns-id"] : data.name;
          return typeof providerId === "string" && providerId ? { kind: "accepted", providerId } : { kind: "unknown", code: "transport" };
        }
        const fcmCode = data.error?.details?.find((item: { "@type"?: string }) => item["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError")?.errorCode;
        if (credential.provider === "apns" && ["Unregistered", "BadDeviceToken"].includes(data.reason ?? "") || credential.provider === "fcm" && fcmCode === "UNREGISTERED") return { kind: "rejected", code: "invalid_token" };
        if ([401, 403].includes(response.status)) {
          if (tokens.get(key) === auth) tokens.delete(key);
          const refresh = cached && (credential.provider === "fcm" && response.status === 401 || credential.provider === "apns" && ["ExpiredProviderToken", "InvalidProviderToken"].includes(data.reason ?? ""));
          return { kind: "rejected", code: refresh ? "auth_refresh" : "credential" };
        }
        if (response.status === 429 || response.status >= 500) {
          const retry = response.headers["retry-after"];
          const retryAfterMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - now)) : 60000;
          return { kind: "rejected", code: "transient", retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : 60000 };
        }
        return { kind: "rejected", code: "payload" };
      } catch { return { kind: "unknown", code: "transport" }; }
      } finally { clearTimeout(timer); }
    },
    close() { native?.close(); tokens.clear(); },
  };
}
