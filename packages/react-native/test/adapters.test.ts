import { beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  platform: { OS: "ios" },
  getPermissions: vi.fn(), requestPermissions: vi.fn(), expoToken: vi.fn(), addListener: vi.fn(), channel: vi.fn(),
  checkNotifications: vi.fn(), requestNotifications: vi.fn(), fcm: vi.fn(), apns: vi.fn(), register: vi.fn(), onRefresh: vi.fn(),
  messaging: { isDeviceRegisteredForRemoteMessages: false }, keychainGet: vi.fn(), keychainSet: vi.fn(), secureGet: vi.fn(), secureSet: vi.fn(),
}));
vi.mock("../src/protected-store.js", () => ({ createProtectedStore: () => ({ get: vi.fn(), set: vi.fn() }) }));
vi.mock("react-native", () => ({ Platform: native.platform, TurboModuleRegistry: { get: () => null } }));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: native.getPermissions, requestPermissionsAsync: native.requestPermissions,
  getDevicePushTokenAsync: native.expoToken, addPushTokenListener: native.addListener,
  setNotificationChannelAsync: native.channel, AndroidImportance: { DEFAULT: 3 }, IosAuthorizationStatus: { PROVISIONAL: 3 },
}));
vi.mock("expo-crypto", () => ({ getRandomBytesAsync: async (length: number) => new Uint8Array(length) }));
vi.mock("expo-secure-store", () => ({ getItemAsync: native.secureGet, setItemAsync: native.secureSet, AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 4 }));
vi.mock("react-native-get-random-values", () => ({}));
vi.mock("react-native-keychain", () => ({ getGenericPassword: native.keychainGet, setGenericPassword: native.keychainSet, ACCESSIBLE: { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "device-only" } }));
vi.mock("react-native-permissions", () => ({ checkNotifications: native.checkNotifications, requestNotifications: native.requestNotifications }));
vi.mock("@react-native-firebase/messaging", () => ({ getMessaging: () => native.messaging, getToken: native.fcm, getAPNSToken: native.apns, registerDeviceForRemoteMessages: native.register, onTokenRefresh: native.onRefresh }));
import { createExpoAdapter } from "../src/expo.js";
import { createBareAdapter } from "../src/bare.js";

beforeEach(() => {
  vi.resetAllMocks();
  native.platform.OS = "ios";
  native.getPermissions.mockResolvedValue({ status: "undetermined", granted: false });
  native.requestPermissions.mockResolvedValue({ status: "granted", granted: true });
  native.checkNotifications.mockResolvedValue({ status: "denied", settings: {} });
  native.requestNotifications.mockResolvedValue({ status: "granted", settings: {} });
});
it("Expo reads permissions without prompting and preserves provisional authorization", async () => {
  const adapter = createExpoAdapter({ androidChannel: { id: "updates", name: "Updates" } });
  expect(await adapter.getPermission()).toBe("not_determined");
  native.getPermissions.mockResolvedValue({ granted: false, status: "undetermined", ios: { status: 3 } });
  expect(await adapter.getPermission()).toBe("provisional");
  expect(native.requestPermissions).not.toHaveBeenCalled();
  expect(native.channel).not.toHaveBeenCalled();
  native.platform.OS = "android";
  await adapter.requestPermission();
  expect(native.channel).toHaveBeenCalledWith("updates", { name: "Updates", importance: 3 });
  expect(native.channel.mock.invocationCallOrder[0]).toBeLessThan(native.requestPermissions.mock.invocationCallOrder[0]!);
});
it("Expo forwards native token changes without recursively reading a token", async () => {
  const adapter = createExpoAdapter({ androidChannel: { id: "updates", name: "Updates" } });
  const remove = vi.fn();
  native.addListener.mockReturnValue({ remove });
  const listener = vi.fn();
  const unsubscribe = adapter.subscribeToken(listener);
  native.addListener.mock.calls[0]![0]({ type: "ios", data: "apns" });
  expect(listener).toHaveBeenCalledWith("apns");
  expect(native.expoToken).not.toHaveBeenCalled();
  unsubscribe();
  expect(remove).toHaveBeenCalledOnce();
  native.expoToken.mockResolvedValue({ type: "android", data: "wrong-platform" });
  await expect(adapter.getToken()).rejects.toMatchObject({ code: "invalid_native_token" });
});
it("bare uses APNs on iOS and FCM on Android without implicit permission requests", async () => {
  const adapter = createBareAdapter();
  native.apns.mockResolvedValue("apns-token");
  native.fcm.mockResolvedValue("fcm-token");
  expect(await adapter.getPermission()).toBe("not_determined");
  expect(native.requestNotifications).not.toHaveBeenCalled();
  expect(await adapter.getToken()).toBe("apns-token");
  expect(native.register).toHaveBeenCalledWith(native.messaging);
  expect(native.fcm).not.toHaveBeenCalled();
  native.platform.OS = "android";
  expect(await adapter.getPermission()).toBe("denied");
  expect(await adapter.getToken()).toBe("fcm-token");
  await adapter.requestPermission();
  expect(native.requestNotifications).toHaveBeenCalledOnce();
});
it("bare fences APNs token refresh callbacks after listener removal", async () => {
  const adapter = createBareAdapter();
  native.onRefresh.mockReturnValue(vi.fn());
  native.apns.mockResolvedValue("apns-new");
  const listener = vi.fn();
  const unsubscribe = adapter.subscribeToken(listener);
  native.onRefresh.mock.calls[0]![1]("fcm-value");
  unsubscribe();
  await Promise.resolve();
  expect(listener).not.toHaveBeenCalled();
});
it("adapters keep credentials in device-only secure storage", async () => {
  const expo = createExpoAdapter({ androidChannel: { id: "updates", name: "Updates" } });
  await expo.secrets.set("key", "value");
  expect(native.secureSet).toHaveBeenCalledWith("key", "value", { keychainAccessible: 4 });
  const bare = createBareAdapter();
  native.keychainSet.mockResolvedValue({ service: "key" });
  await bare.secrets.set("key", "value");
  expect(native.keychainSet).toHaveBeenCalledWith("galinum", "value", { service: "key", accessible: "device-only" });
  native.keychainSet.mockResolvedValue(false);
  await expect(bare.secrets.set("key", "value")).rejects.toMatchObject({ code: "storage_failure" });
});
