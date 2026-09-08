export { createGalinumClient, GalinumClient } from "./client.js";
export { GalinumProvider, useGalinum, useGalinumClient, useGalinumSnapshot } from "./context.js";
export { GalinumError } from "./types.js";
export type { KeyValueStore, NativeAdapter, NativeConfig, NativeSnapshot, InstallationSnapshot, Permission, Properties, JsonValue } from "./types.js";

export { EventAdmissionError } from './journal.js';
export type { EventReceipt, JournalPort } from './journal.js';
