import { AppRegistry, Linking, NativeModules } from 'react-native';
import { createGalinumClient, GalinumError, InAppController, type NotificationInteraction } from '@galinum/react-native';
import { createExpoAdapter } from '@galinum/react-native/expo';
import { VerificationApp, showInApp } from '../inapp';

const harness = NativeModules.JournalHarness;
AppRegistry.registerComponent('main', () => VerificationApp);
type Config = { phase: string; origin: string; publishableKey: string; appId: string; token: string; storageKey: string; foreground?: 'display' | 'suppress'; reference?: { targetId: string }; deliveryId?: string; inapp?: { theme?: 'light' | 'dark' | 'auto'; custom?: boolean; terminal?: 'clicked' | 'dismissed' } };
const config: Config = JSON.parse(harness.config());
const check = (condition: unknown, label: string) => { if (!condition) throw new Error(label); };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const code = (error: unknown) => (error instanceof GalinumError ? error.code : String(error));
const result: Record<string, unknown> = { phase: config.phase };
const category = 'galinum-updates';
async function run() {
  const adapter = createExpoAdapter({ androidChannel: { id: 'updates', name: 'Updates' } });
  let scope = '';
  const port = adapter.journal;
  adapter.journal = { ...port, claim: value => { scope = value; return port.claim(value); } };
  adapter.getToken = async () => config.token;
  adapter.subscribeToken = () => () => {};
  const http: unknown[] = [];
  const notifications = { foreground: config.foreground ?? 'display', channels: [], actions: [{ id: 'open', title: 'Open' }, { id: 'later', title: 'Later' }], categories: [{ id: category, actions: ['open', 'later'] }] } as const;
  const makeClient = (storageKey = config.storageKey, carrier = true) => createGalinumClient({ apiBase: config.origin, publishableKey: config.publishableKey, appId: config.appId, platform: 'ios', environment: 'development', storageKey, adapter, requestTimeoutMs: 3000, ...(carrier ? { notifications } : {}),
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      http.push({ path: new URL(String(input)).pathname, method: init?.method ?? 'GET', status: response.status });
      return response;
    },
  });
  const inspect = async () => JSON.parse(await harness.inspect(scope));
  const delivered = async () => JSON.parse(await harness.delivered()) as { id: string }[];
  const handled: NotificationInteraction[] = [];
  const waitHandled = async (count: number, timeoutMs: number) => { const start = Date.now(); while (handled.length < count) { if (Date.now() - start > timeoutMs) throw new Error('interaction_not_handled'); await sleep(50); } };
  const ready = () => harness.save('ready', JSON.stringify({ phase: config.phase, verified: true }));
  const phase = config.phase;
  if (phase === 'seed') {
    const client = makeClient();
    await client.identify('journal-A');
    await client.setConsent(true);
    await client.requestPermission();
    result.installation = client.getSnapshot().installation;
    result.delegate = JSON.parse(await harness.delegateState());
    result.settings = (await inspect()).settings;
    const installation = result.installation as { permission: string; hasToken: boolean; capabilities: { actions: string[]; categories?: { id: string; actions: { id: string }[] }[] } };
    check(installation.permission === 'granted' && installation.hasToken, 'granted_permission_and_token_registered');
    check(installation.capabilities.actions.includes('open') && installation.capabilities.categories?.some(entry => entry.id === category && entry.actions.length === 2), 'capabilities_advertised_from_native_setup');
    check((result.delegate as { composed: boolean; previous: string }).composed && (result.delegate as { previous: string }).previous.includes('NotificationCenterManager'), 'expo_delegate_composed');
  } else if (phase === 'cold') {
    const client = makeClient();
    client.setNotificationHandler(interaction => { handled.push(interaction); });
    await client.start();
    await sleep(300);
    result.handledBeforeIdentify = handled.length;
    await client.identify('journal-A');
    await waitHandled(1, 15000);
    await client.flush();
    result.handled = handled;
    check(result.handledBeforeIdentify === 0, 'no_handler_before_identity_confirmation');
    check(handled[0]!.kind === 'tap' && handled[0]!.targetId === config.reference!.targetId && handled[0]!.userId === 'journal-A', 'os_tap_routed_to_current_identity');
  } else if (phase === 'warm') {
    const client = makeClient();
    client.setNotificationHandler(interaction => { handled.push(interaction); });
    await client.identify('journal-A');
    await ready();
    await waitHandled(1, 120000);
    await client.flush();
    result.handled = handled;
    result.delivered = await delivered();
    check(handled[0]!.kind === 'action' && handled[0]!.actionId === 'open' && handled[0]!.targetId === config.reference!.targetId, 'os_action_routed');
  } else if (phase === 'suppress' || phase === 'revoked' || phase === 'old-user') {
    const client = makeClient();
    client.setNotificationHandler(interaction => { handled.push(interaction); });
    await client.identify('journal-A');
    if (phase === 'revoked') await client.setConsent(false);
    if (phase === 'old-user') { await client.reset(); await client.identify('journal-B'); }
    const before = (await inspect()).observations.length as number;
    await ready();
    const start = Date.now();
    while ((await inspect()).observations.length === before) { if (Date.now() - start > 120000) throw new Error('observation_not_recorded'); await sleep(200); }
    await sleep(1500);
    result.state = await inspect();
    result.delivered = await delivered();
    result.handled = handled;
    const last = (result.state as { observations: { status: string }[] }).observations.at(-1)!;
    check(!(result.delivered as { id: string }[]).some(entry => entry.id === config.reference!.targetId), 'no_os_presentation');
    check(handled.length === 0, 'no_handler_call');
    if (phase === 'old-user') check(last.status === 'retired', 'old_user_envelope_retired');
    if (phase === 'revoked') await client.setConsent(true);
    if (phase === 'old-user') { await client.reset(); await client.identify('journal-A'); }
    await client.flush();
  } else if (phase === 'inapp-terminal' || phase === 'inapp-completion') {
    const client = makeClient();
    await client.start();
    result.confirmedBeforeIdentify = client.inApp.getSnapshot().appConfirmed;
    check(result.confirmedBeforeIdentify === false, 'rehydration_never_authorizes_inapp');
    await client.identify('journal-A');
    let entry = 0, routed = false;
    const captured = client.session();
    const controller = new InAppController(client.inApp, client.feedback, {
      id: () => client.inApp.getSnapshot().owner + ':' + (++entry),
      appSchemes: ['galinum-verify'],
      openDestination: async destination => {
        await Linking.openURL(destination.url);
        await captured.track('inapp_native_clicked');
        routed = true;
      },
    });
    showInApp(controller, phase + ':' + config.deliveryId, { theme: config.inapp?.theme, custom: config.inapp?.custom });
    await ready();
    if (phase === 'inapp-terminal') {
      const deadline = Date.now() + 120000;
      const terminal = config.inapp?.terminal ?? 'clicked';
      const settled = async () => terminal === 'clicked' ? routed : client.feedback.isCompleted('journal-A', config.deliveryId!);
      while (!(await settled())) { if (Date.now() > deadline) throw new Error('inapp_action_not_settled'); await sleep(100); }
      check(await client.feedback.isCompleted('journal-A', config.deliveryId!), 'terminal_completion_durable');
      await client.feedback.flush();
      result.routed = routed;
      result.terminal = terminal;
    } else {
      check(await client.feedback.isCompleted('journal-A', config.deliveryId!), 'completion_survives_process_restart');
      const deadline = Date.now() + 15000;
      while (controller.getSnapshot().phase !== 'empty') { if (Date.now() > deadline) throw new Error('completed_delivery_represented'); await sleep(100); }
      const other = makeClient(config.storageKey + '.other', false);
      await other.identify('journal-A');
      check(!(await other.feedback.isCompleted('journal-A', config.deliveryId!)), 'second_client_has_no_local_completion');
      const decision = await other.inApp.decide({ userId: 'journal-A', entryId: other.inApp.getSnapshot().owner + ':entry', requestId: other.inApp.getSnapshot().owner + ':request', path: '/settings' }, new AbortController().signal);
      check(!decision.messages.some(message => message.deliveryId === config.deliveryId), 'shared_server_completion_suppresses_second_client');
      result.sharedCompletion = true;
      other.dispose();
    }
    result.controller = controller.getSnapshot();
  } else throw new Error('unknown_phase');
  result.http = http;
  await harness.save(phase, JSON.stringify({ ...result, verified: true }));
}
void run().catch(async error => { await harness.save(config.phase, JSON.stringify({ ...result, verified: false, code: code(error), stack: String(error?.stack ?? '') })); });
