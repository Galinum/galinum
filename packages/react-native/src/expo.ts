import { createNativeJournal } from './journal-native.js';
import * as Crypto from "expo-crypto";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { createProtectedStore } from "./protected-store.js";
import { GalinumError, type NativeAdapter, type Permission } from "./types.js";

function permission(value: Notifications.NotificationPermissionsStatus): Permission {
  if (value.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) return "provisional";
  if (value.granted) return "granted";
  return value.status === "undetermined" ? "not_determined" : "denied";
}
export function createExpoAdapter(options: { androidChannel: { id: string; name: string } }): NativeAdapter {
  if (Platform.OS !== "ios" && Platform.OS !== "android") throw new GalinumError("unsupported_platform");
  const secrets = {
    get: (key: string) => SecureStore.getItemAsync(key),
    set: (key: string, value: string) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
  };
  return {
    journal: createNativeJournal(),
    secrets,
    storage: createProtectedStore(secrets, Crypto.getRandomBytesAsync),
    randomBytes: length => Crypto.getRandomBytesAsync(length),
    getPermission: async () => permission(await Notifications.getPermissionsAsync()),
    requestPermission: async () => {
      if (Platform.OS === "android") await Notifications.setNotificationChannelAsync(options.androidChannel.id, { name: options.androidChannel.name, importance: Notifications.AndroidImportance.DEFAULT });
      return permission(await Notifications.requestPermissionsAsync());
    },
    getToken: async () => {
      const token = await Notifications.getDevicePushTokenAsync();
      if (typeof token.data !== "string" || token.type !== Platform.OS) throw new GalinumError("invalid_native_token");
      return token.data;
    },
    subscribeToken: listener => {
      const subscription = Notifications.addPushTokenListener(token => {
        if (typeof token.data === "string" && token.type === Platform.OS) listener(token.data);
      });
      return () => subscription.remove();
    },
  };
}
