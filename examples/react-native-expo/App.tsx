import { useState } from "react";
import { AppState, Button, Platform, ScrollView, Text, TextInput } from "react-native";
import { createGalinumClient, GalinumError, GalinumProvider, useGalinum } from "@galinum/react-native";
import { createExpoAdapter } from "@galinum/react-native/expo";
import config from "./app.json";

const client = createGalinumClient({
  apiBase: config.expo.extra.galinumApiBase,
  publishableKey: config.expo.extra.galinumPublishableKey,
  appId: Platform.OS === "ios" ? config.expo.ios.bundleIdentifier : config.expo.android.package,
  platform: Platform.OS === "ios" ? "ios" : "android",
  environment: "development",
  storageKey: "galinum.nativefoundation.development",
  adapter: createExpoAdapter({ androidChannel: { id: "updates", name: "Product updates" } }),
});

function Foundation() {
  const galinum = useGalinum();
  const [userId, setUserId] = useState("example-user-a");
  const [result, setResult] = useState("Ready for setup");
  const run = (operation: () => Promise<void>) => {
    void operation().then(() => setResult("Acknowledged")).catch(error => setResult(error instanceof GalinumError ? error.code : "Operation failed"));
  };
  return <ScrollView contentContainerStyle={{ padding: 32, gap: 16, paddingTop: 72 }}>
    <Text style={{ fontSize: 24 }}>Native client foundation</Text>
    <Text>Identify a user, then choose product consent and notification permission separately.</Text>
    <TextInput accessibilityLabel="User ID" value={userId} onChangeText={setUserId} autoCapitalize="none" style={{ borderWidth: 1, padding: 12 }} />
    <Button title="Identify user" onPress={() => run(() => galinum.identify(userId))} />
    <Button title="Reset user" onPress={() => run(galinum.reset)} />
    <Button title="Enable product consent" onPress={() => run(() => galinum.setConsent(true))} />
    <Button title="Revoke product consent" onPress={() => run(() => galinum.setConsent(false))} />
    <Button title="Request notification permission" onPress={() => run(galinum.requestPermission)} />
    <Button title="Refresh permission and token" onPress={() => run(galinum.syncDevice)} />
    <Button title="Record foreground activity" onPress={() => {
      if (AppState.currentState === "active") run(galinum.recordForegroundActivity);
    }} />
    <Button title="Track example event" onPress={() => run(() => galinum.track("native_example_used"))} />
    <Text accessibilityLiveRegion="polite">{result}</Text>
    <Text>{JSON.stringify(galinum.snapshot, null, 2)}</Text>
  </ScrollView>;
}
export default function App() {
  return <GalinumProvider client={client}><Foundation /></GalinumProvider>;
}
