import { useSyncExternalStore } from 'react';
import { Pressable, Text, View } from 'react-native';
import { InAppLifecycle, InAppMessages, type InAppController, type InAppMessagesProps } from '@galinum/react-native';

export type InAppOptions = { theme?: InAppMessagesProps['theme']; custom?: boolean };
const listeners = new Set<() => void>();
let current: { controller: InAppController; entry: string; options: InAppOptions } | null = null;
const snapshot = () => current;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const customRender: NonNullable<InAppMessagesProps['render']> = (message, actions) => <View testID="custom-inapp" style={{ padding: 16, backgroundColor: '#fde68a' }}>
  <Text>{'Custom ' + (message.content.title ?? '')}</Text>
  <Pressable accessibilityRole="button" onPress={() => { void actions.click(); }}><Text>Custom open</Text></Pressable>
</View>;
export function showInApp(controller: InAppController, entry: string, options: InAppOptions = {}) {
  current = { controller, entry, options };
  for (const listener of listeners) listener();
}
export function VerificationApp() {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  return <View style={{ flex: 1, padding: 24, paddingTop: 72 }}>
    <Text>Galinum native verification</Text>
    {state && <>
      <InAppLifecycle controller={state.controller} routeKey={state.entry} path="/settings" navigationReady />
      <InAppMessages controller={state.controller} theme={state.options.theme} render={state.options.custom ? customRender : undefined} />
    </>}
  </View>;
}
