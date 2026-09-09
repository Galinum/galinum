import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';
import type { InAppController } from './inapp-controller.js';
import type { InAppActions, InAppMessage } from './inapp-types.js';

export type InAppMessagesProps = { controller: InAppController; theme?: 'light' | 'dark' | 'auto'; render?: (message: InAppMessage, actions: InAppActions) => ReactNode };

export function InAppLifecycle({ controller, routeKey, path, navigationReady }: { controller: InAppController; routeKey: string; path: string; navigationReady: boolean }) {
  useLayoutEffect(() => { controller.navigate(routeKey, path, navigationReady); }, [controller, routeKey, path, navigationReady]);
  useEffect(() => {
    controller.foreground(AppState.currentState === 'active');
    const subscription = AppState.addEventListener('change', state => controller.foreground(state === 'active'));
    return () => { subscription.remove(); };
  }, [controller]);
  return null;
}

export function InAppMessages({ controller, theme = 'auto', render }: InAppMessagesProps) {
  const [host] = useState(() => Symbol('inapp-host'));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useLayoutEffect(() => controller.attach(host), [controller, host]);
  if (state.host !== host || !state.message || !state.capture) return null;
  return <Candidate key={state.capture.entryId + ':' + state.message.deliveryId} controller={controller} host={host} message={state.message} capture={state.capture} theme={theme} render={render} error={state.error} />;
}

function Candidate({ controller, host, message, capture, theme, render, error }: InAppMessagesProps & { host: symbol; message: InAppMessage; capture: NonNullable<ReturnType<InAppController['getSnapshot']>['capture']>; error?: string }) {
  const actions = useMemo(() => controller.actions(host, capture, message), [controller, host, capture, message]);
  const custom = render ? render(message, actions) : undefined;
  const skipped = !!render && (custom === null || custom === undefined || custom === false);
  useLayoutEffect(() => {
    if (skipped) controller.skip(host, capture, message);
    else controller.commit(host, capture, message);
  }, [controller, host, capture, message, skipped]);
  if (skipped) return null;
  const committed = () => controller.presented(host, capture, message);
  if (render) return <View testID="galinum-custom" onLayout={committed}>{custom}</View>;
  return <Presentation message={message} actions={actions} theme={theme} error={error} committed={committed} />;
}

function Presentation({ message, actions, theme, error, committed }: { message: InAppMessage; actions: InAppActions; theme?: InAppMessagesProps['theme']; error?: string; committed(): void }) {
  const systemTheme = useColorScheme();
  const dark = theme === 'dark' || (theme === 'auto' && systemTheme === 'dark');
  const palette = dark ? { backgroundColor: '#18181b', color: '#fafafa', borderColor: '#3f3f46' } : { backgroundColor: '#ffffff', color: '#18181b', borderColor: '#e4e4e7' };
  const [imageFailed, setImageFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = (action: () => Promise<void>) => { if (busy) return; setBusy(true); void action().catch(() => {}).finally(() => setBusy(false)); };
  const { content } = message;
  const modal = (content.presentation ?? (content.media ? 'modal' : 'toast')) === 'modal';
  const body = <View testID="galinum-message" accessibilityViewIsModal={modal} style={[styles.card, palette, !modal && styles.toast]} onLayout={modal ? undefined : committed}>
    {content.media && !imageFailed && <Image testID="galinum-media" source={{ uri: content.media.url }} accessibilityLabel={content.media.alt} accessible={!content.media.decorative} resizeMode="cover" style={modal ? styles.hero : styles.thumbnail} onError={() => setImageFailed(true)} />}
    <View style={[styles.copy, !modal && styles.toastCopy]}>
      {content.title && <Text accessibilityRole="header" style={[styles.title, { color: palette.color }]}>{content.title}</Text>}
      {content.body && <Text style={[styles.body, { color: palette.color }]}>{content.body}</Text>}
      <View style={styles.actions}>
        {content.cta && <Pressable accessibilityRole="button" disabled={busy} onPress={() => run(actions.click)} style={[styles.button, { backgroundColor: palette.color }]}><Text style={{ color: palette.backgroundColor, fontWeight: '600' }}>{content.cta.label}</Text></Pressable>}
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss message" disabled={busy} onPress={() => run(actions.dismiss)} style={styles.button}><Text style={{ color: palette.color }}>Dismiss</Text></Pressable>
      </View>
      {error && <View accessibilityLiveRegion="polite"><Text style={[styles.body, { color: palette.color }]}>{error}</Text><Pressable accessibilityRole="button" disabled={busy} onPress={() => run(actions.retry)} style={styles.button}><Text style={{ color: palette.color }}>Try again</Text></Pressable></View>}
    </View>
  </View>;
  if (!modal) return body;
  return <Modal transparent visible animationType="none" onShow={committed} onRequestClose={() => run(actions.dismiss)}>
    <View style={styles.backdrop}>
      <Pressable accessibilityLabel="Dismiss message" accessibilityRole="button" style={StyleSheet.absoluteFill} onPress={() => run(actions.dismiss)} />
      <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalContent} bounces={false}>{body}</ScrollView>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 16, overflow: 'hidden', width: '100%', maxWidth: 480 },
  toast: { alignSelf: 'center', marginVertical: 12, flexDirection: 'row' },
  copy: { padding: 20, gap: 12 },
  toastCopy: { flex: 1 },
  title: { fontSize: 20, fontWeight: '600', lineHeight: 26 },
  body: { fontSize: 16, lineHeight: 23 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: 44, minWidth: 44, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  hero: { width: '100%', height: 220 },
  thumbnail: { width: 72, height: 72, marginTop: 20, marginLeft: 16, borderRadius: 8 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.52)', justifyContent: 'center', padding: 24 },
  modalScroll: { flexGrow: 0, width: '100%' },
  modalContent: { alignItems: 'center' },
});
