import { normalizePublicOrigin } from "./local-media-store.js";

export function serverConfig(environment: NodeJS.ProcessEnv) {
  const host = environment.GALINUM_HOST ?? "127.0.0.1";
  if (!/^[A-Za-z0-9.:-]+$/.test(host)) {
    throw new Error("GALINUM_HOST must be a hostname or IP address");
  }
  const portValue = environment.PORT ?? "3000";
  if (!/^\d+$/.test(portValue)) throw new Error("PORT must be an integer from 1 to 65535");
  const port = Number(portValue);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer from 1 to 65535");

  const publicOrigin = environment.GALINUM_PUBLIC_URL
    ? normalizePublicOrigin(environment.GALINUM_PUBLIC_URL)
    : null;
  if (environment.GALINUM_MEDIA_DIR && !publicOrigin) {
    throw new Error("GALINUM_PUBLIC_URL is required with GALINUM_MEDIA_DIR");
  }
  const githubFields = [environment.GALINUM_GITHUB_APP_ID, environment.GALINUM_GITHUB_CLIENT_ID, environment.GALINUM_GITHUB_PRIVATE_KEY];
  if (githubFields.some(Boolean) && !githubFields.every(Boolean)) throw new Error("GitHub App ID, client ID and private key must be configured together.");
  const appId = Number(environment.GALINUM_GITHUB_APP_ID);
  if (githubFields.every(Boolean) && (!Number.isSafeInteger(appId) || appId < 1)) throw new Error("Invalid GALINUM_GITHUB_APP_ID.");
  return {
    operatorKey: environment.GALINUM_OPERATOR_KEY,
    github: githubFields.every(Boolean) ? { appId, clientId: environment.GALINUM_GITHUB_CLIENT_ID!, privateKey: environment.GALINUM_GITHUB_PRIVATE_KEY! } : undefined,
    host,
    port,
    mediaDirectory: environment.GALINUM_MEDIA_DIR ?? null,
    publicOrigin: publicOrigin ?? `http://localhost:${port}`,
    warning: publicOrigin ? null : `GALINUM_PUBLIC_URL is unset; media URLs default to http://localhost:${port}`,
  };
}
