import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { GalinumClient } from "./client.js";

const Context = createContext<GalinumClient | null>(null);
export function GalinumProvider({ client, children }: { client: GalinumClient; children: ReactNode }) {
  useEffect(() => { void client.start().catch(() => {}); }, [client]);
  return <Context.Provider value={client}>{children}</Context.Provider>;
}
export function useGalinumClient(): GalinumClient {
  const client = useContext(Context);
  if (!client) throw new Error("GalinumProvider is required");
  return client;
}
export function useGalinumSnapshot() {
  const client = useGalinumClient();
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}
export function useGalinum() {
  const client = useGalinumClient();
  const snapshot = useGalinumSnapshot();
  return useMemo(() => ({ ...client.session(), identify: client.identify, reset: client.reset, flush: client.flush, snapshot }), [client, snapshot]);
}
