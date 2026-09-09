import { createEncryptedVault, createPushEngine, createPushProvider } from "@galinum/push";
import { MemoryMediaStore } from "./local-media-store.js";
import type { LocalProductOptions, ProductStore } from "./local-product.js";

import { pushTransaction } from "./communication-push.js";
export function createServerPush(store: ProductStore, options: LocalProductOptions & { projectId: string; secretKey: string; publishableKey: string; now: () => number }) {
  const provider = options.pushProvider ?? createPushProvider();
  const vault = options.pushEncryptionKey ? createEncryptedVault(options.pushEncryptionKey) : null;
  const configuration = { projectId: options.projectId, vault, media: options.media ?? new MemoryMediaStore() };
  const engine = createPushEngine({ projectId: options.projectId, store: { transaction: (work) => store.transaction((session) => work(pushTransaction(session, options.communicationEffects, configuration))) }, vault, provider, maySend: options.pushMaySend ?? (async () => true), recordAcceptance: options.pushRecordAcceptance ?? (async () => {}), now: options.now });
  const runDue = async () => {
    const result = await engine.runPass({ maxUnits: Number.MAX_SAFE_INTEGER, maxPages: Number.MAX_SAFE_INTEGER });
    return { ...result, processed: result.units.dispatch };
  };
  return { engine: { ...engine, runDue }, close() { provider.close?.(); } };
}
