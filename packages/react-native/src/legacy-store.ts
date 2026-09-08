import { existsMMKV } from "react-native-mmkv";
import { GalinumError } from "./types.js";

export async function checkLegacyState(key: string): Promise<void> {
  if (existsMMKV(key + ".state")) throw new GalinumError("legacy_format");
}
