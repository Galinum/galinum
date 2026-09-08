import { checkLegacyState } from "./legacy-store.js";
import { createNativeJournal } from './journal-native.js';
import "react-native-get-random-values";
import { Platform } from "react-native";
import { getGenericPassword, setGenericPassword, ACCESSIBLE } from "react-native-keychain";
import { checkNotifications, requestNotifications } from "react-native-permissions";
import { getMessaging, getToken, getAPNSToken, registerDeviceForRemoteMessages, onTokenRefresh } from "@react-native-firebase/messaging";
import { GalinumError, type NativeAdapter, type Permission } from "./types.js";

function permission(value: Awaited<ReturnType<typeof checkNotifications>>): Permission {
  if (value.settings.provisional) return "provisional";
  return value.status === "granted" ? "granted" : value.status === "denied" ? Platform.OS === "ios" ? "not_determined" : "denied" : value.status === "unavailable" ? "unknown" : "denied";
}
export function createBareAdapter(): NativeAdapter {
  if (Platform.OS !== "ios" && Platform.OS !== "android") throw new GalinumError("unsupported_platform");
  const messaging = getMessaging();
  const readToken = async () => {
    if (Platform.OS === "ios") {
      if (!messaging.isDeviceRegisteredForRemoteMessages) await registerDeviceForRemoteMessages(messaging);
      return getAPNSToken(messaging);
    }
    return getToken(messaging);
  };
  const secrets = {
    get: async (key: string) => {
      const value = await getGenericPassword({ service: key });
      return value ? value.password : null;
    },
    set: async (key: string, value: string) => {
      const result = await setGenericPassword("galinum", value, { service: key, accessible: ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
      if (!result) throw new GalinumError("storage_failure");
    },
  };
  const randomBytes = async (length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length));
  return {
    journal: createNativeJournal(),
    secrets,
    checkLegacyState,
    randomBytes,
    getPermission: async () => permission(await checkNotifications()),
    requestPermission: async () => permission(await requestNotifications(["alert", "badge", "sound"])),
    getToken: readToken,
    subscribeToken: listener => {
      let active = true;
      const unsubscribe = onTokenRefresh(messaging, token => {
        if (Platform.OS === "android") { if (active) listener(token); }
        else void getAPNSToken(messaging).then(value => { if (active && value !== null) listener(value); }).catch(() => {});
      });
      return () => { active = false; unsubscribe(); };
    },
  };
}
