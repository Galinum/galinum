# @galinum/react-native

Native installation, identity, event, permission and consent client. It uses the
public installation, identify and ordered observation HTTP APIs. Notification routing, actions,
receipt reporting and in-app rendering are not implemented.

## Create one client

Create one client per project, app and environment in one JavaScript runtime.
Keep it outside React renders. Use a distinct `storageKey` for each configuration.
The key accepts letters, digits, underscores, periods and hyphens. Reusing stored
credentials with a different configuration fails closed. Never share this secure
storage namespace with another client or background runtime.

```tsx
import { Platform } from 'react-native';
import { createGalinumClient, GalinumProvider } from '@galinum/react-native';
import { createExpoAdapter } from '@galinum/react-native/expo';

const client = createGalinumClient({
  apiBase: 'https://api.example.com',
  publishableKey: 'pub_your_project_key',
  appId: 'com.example.product',
  platform: Platform.OS === 'ios' ? 'ios' : 'android',
  environment: 'production',
  storageKey: 'galinum.product.production',
  adapter: createExpoAdapter({
    androidChannel: { id: 'updates', name: 'Product updates' },
  }),
});

export function App({ children }: { children: React.ReactNode }) {
  return <GalinumProvider client={client}>{children}</GalinumProvider>;
}
```

Use your server's origin, without a path. Use HTTPS outside loopback development.
Never put a project secret key or provider credentials in the application.

The provider calls `start()` without requesting OS permission. Without a provider,
call and await `client.start()`. Operations also initialize the installation when
needed. The provider does not dispose the shared client when it unmounts. Call
`dispose()` when the application's client owner shuts down permanently.

## Application API

`useGalinumClient()` returns the client. `useGalinumSnapshot()` returns its immutable
external-store snapshot. `useGalinum()` returns that snapshot, identity controls,
and session-bound operations. `track` returns an event receipt; other asynchronous
methods return `Promise<void>`.

| Method | Behavior |
| --- | --- |
| `start()` | Load durable credentials/session, bootstrap, reconcile binding, permission and token. No prompt or activity. |
| `identify(userId, traits?)` | Identify through the public API before binding. Switching users clears product consent. |
| `reset()` | Invalidate old callbacks immediately; persist anonymous intent, unbind and clear the server token. Keep installation credentials. |
| `track(event, props?, { eventId }?)` | Reserve invocation order, then persist an event for the captured identity. Return `{ eventId, state: "queued" \| "acknowledged" }`. |
| `flush()` | Send the captured journal watermark; resolve after its server acknowledgements are durable. |
| `setConsent(boolean)` | Persist product consent separately from OS authorization. True requires identification. |
| `requestPermission()` | Request OS authorization only on this explicit call; synchronize the result. Does not enable consent. |
| `syncDevice()` | Refresh permission and native token without prompting or recording activity. |
| `recordForegroundActivity()` | Record explicit foreground use for installation selection. Requires identification. |
| `session()` | Capture session-bound track, consent, permission, synchronization and activity methods. |
| `getSnapshot()` / `subscribe(listener)` | Stable, deeply frozen snapshots for `useSyncExternalStore`. |
| `dispose()` | Fence callbacks and remove native subscriptions. A disposed client cannot restart. |

Use hooks or capture `const session = client.session()` before starting delayed
work. Old session operations reject with `GalinumError.code === 'superseded'` after
reset or switching accounts. Direct client methods intentionally target the current
session when called. Identity controls remain application-owned.

```tsx
const { requestPermission, setConsent, track } = useGalinum();
await setConsent(true);
await requestPermission();
await track('onboarding_completed', { source: 'native' });
```

Call `requestPermission()` from your own permission explanation or button. Bind
consent to your product's separate opt-in control. Only a bound installation with
consent and granted/provisional permission uploads a token. Revocation clears the
server token; it does not revoke OS permission or delete the provider's device token.

Call `syncDevice()` after returning from OS settings. Use React Native
[AppState](https://reactnative.dev/docs/appstate) to decide when actual foreground
use merits `recordForegroundActivity()`. The SDK never treats token refresh,
initialization, identification, tracking or background synchronization as activity.

Traits and event properties accept JSON values. The HTTP contract limits event
names to 80 characters and serialized properties to 4 KB. No web page context is
added. Snapshots expose status, user ID, product consent, installation state and
sanitized error codes. They contain no capability or token values. The SDK logs
nothing and never forwards server error bodies or native error text.

## Ordered native journal

Expo and bare adapters include the app-process TurboModule. Rebuild native projects
after installation; Expo Go cannot load it. React Native autolinking and Codegen
register the module. Android uses SQLCipher Android 4.17.0 and AndroidX SQLite 2.6.2.
iOS uses the SQLCipher 4.10.0 CocoaPod and Objective-C++ Codegen integration. Install
Pods after adding the package. Do not also link system SQLite for this journal.

`track` reserves a memory ticket synchronously before initialization, key reads or
HTTP. It then resolves the captured identity and commits a contiguous per-binding
sequence in SQLCipher. Analytics does not require push consent. A later internal
ingress cannot overtake a valid earlier ticket waiting for initialization.

```ts
const receipt = await client.track('export_completed', { format: 'csv' }, {
  eventId: 'export-job-123',
});
await client.flush();
```

`queued` means the encrypted transaction completed, not that the server received
it. `acknowledged` means the same business event was already acknowledged locally.
Retain your business event ID for retries. `EventAdmissionError.eventId` also makes
an uncertain admission recoverable. Repeat the same event name and properties;
changed data under the same ID fails. A reserved ticket alone is not durable.
Process death before admission can lose it; retry with the retained event ID.

Tracking reconciles the current installation binding without issuing a user
identification request. An acknowledged replay still validates current identity and
storage before returning its receipt. Explicit `identify()` and `start()` retain
their identification behavior.

The sender preserves the exact durable uncertain batch across appends and process
restart. Reads use an indexed prefix of at most 32 commands and the 64 KiB wire
budget. There is no fixed lifetime row limit. Storage exhaustion rejects admission
without reporting it queued. Existing rows and their ordering remain intact.

SQLCipher files remain in Android `noBackupFilesDir` or the iOS app Application
Support directory, excluded from backup with first-unlock file protection. Only a
separate 256-bit journal key enters SecureStore/Keychain. Missing keys never trigger
replacement of an existing database. MMKV still stores installation state.

One process-local native owner controls each scoped journal. A live owner cannot
be stolen. Reset waits for durable native closure as well as the installation's
actual-write and acknowledged binding fences. Startup closes the native gate;
rehydration leaves application identity unconfirmed. Explicit `identify` confirms
application identity. The SDK does not route or display notifications.

Every adapter must provide a `JournalPort`, including custom adapters. Missing
journals fail at client construction with `journal_required`. All `track` calls
return `Promise<EventReceipt>` and preserve the supplied business event ID through
the ordered sender. Custom bridges must preserve the complete JournalPort contract.

## Persistence and recovery

`start()` and `identify(A)` both load saved state before comparing identities.
A saved A keeps consent and token registration even if identify runs first, runs
concurrently with start, or runs in a child effect before the provider's effect.
A real A-to-B switch clears consent and invalidates A's session handles.

Two stores separate credentials from operational data. SecureStore on Expo and
Keychain on bare hold only the installation credentials and a small encryption key.
The installation ID contains 128 random bits; the capability contains 256 random
bits. Both use native cryptographic randomness and the installation API's hex encoding.
The scope is a SHA-256 digest, not an unbounded configuration string.

Both adapters use encrypted `react-native-mmkv` for session intent, one pending
installation mutation and the last acknowledged token fingerprint/revision. Token
values can occur in pending bodies, never in the small credential record. MMKV uses
AES-256 with a 32-character random key containing 192 bits of entropy. An HMAC from
a separately derived key authenticates the serialized operational record. Native
write failures, missing keys, malformed data and failed integrity checks are errors.
There is no size-warning suppression, truncation or automatic data clearing.

The operational file belongs in the application's container. Secure credentials
may survive iOS reinstall; if the operational file is absent, the client starts
anonymous, unbinds the old server user and clears its token during startup. It never
restores a user or consent from Keychain alone. Do not configure MMKV's automatic
`AppGroupIdentifier` storage for installation state. Shared extension/headless storage
ownership is not implemented; such hosts need an app-container `KeyValueStore` in
a custom adapter. Keep device-only keys and exclude these operational files from
backup/restore that could move them without their keys. Missing keys fail visibly.

Storage writes have their own serialization chain, independent of HTTP and native
permission/token reads. Reset/switch update in-memory intent, fence old work, and
schedule durable writes on that chain. Every queued write serializes current
intent when it executes. An already-issued storage write cannot be cancelled or
overtaken. Newer intent follows it, preventing late A writes from restoring A after
the newer write completes.

**Await reset before claiming success.** Persistence is asynchronous. If storage
is unavailable or an earlier write remains blocked, reset rejects. Until the
latest write completes, a crash can still leave the previous saved session. Until
HTTP reconciliation completes, server eligibility can still reflect the old user.
After storage/network recovery, retry `reset()` or `start()`; startup reconciles the
latest durable intent. A write timeout does not release its underlying write barrier.
Do not start a second client/runtime while the first still owns pending writes.
`dispose()` cancels native waiters and network work at its next boundary, but does
not cancel already-issued storage writes or claim those writes completed.

Native token/permission reads have a default 10-second `nativeTimeoutMs`. Session
changes immediately detach obsolete reads and pass an AbortSignal to custom
adapters. Platform calls without cancellation support may finish later; their
results are ignored. Reset does not need a new native permission or token read.
Explicit permission dialogs run outside the network queue without an arbitrary
human-response timeout. Reset/dispose fence them. Passive sync does not supersede
a real permission result.

Reset and identity changes also persist a binding-intent counter and its last
acknowledged counter. An equal user ID from GET is not a server fence. Every reset,
and every unacknowledged identity intent, requires a binding PUT acknowledgement
that advances the server revision, even if the user is already anonymous or already
matches. Same-user writes preserve binding generation, consent and token revision.
Only acknowledgement of the current intent clears its requirement. Restart repeats
reconciliation when that requirement remains. Stored records with missing or invalid
counters fail with `invalid_storage`.
A transport abort or timeout is not server cancellation. Delayed earlier writes
are rejected by server revision guards after the acknowledged fence.

One HTTP queue owns installation revisions. Pending bodies and request IDs persist
before sending. Transport failures, HTTP 408 and server failures receive one exact
retry; HTTP 429 is surfaced. Each acknowledgement is followed by GET. Conflict
retries use fresh request IDs and current revisions, up to three attempts.
Non-binding writes never rebase across binding generations. Obsolete pending binding
intents are discarded rather than deliberately restoring an old user. HTTP waits
use `requestTimeoutMs`; storage waits use `storageTimeoutMs`, both 10 seconds by
default. Storage timeout/failure never counts as a successful durable write.

An eligible `getToken()` returning null means unavailable, not revoked. It preserves
an existing registration. An unchanged fingerprint with a matching acknowledged
server token revision avoids a token PUT, including on restart. A missing server
registration is repaired. The custom-adapter listener may emit null only for a
definite revocation signal. The bare adapter never emits null for an APNs read
that has not received a token yet. Consent/permission ineligibility still clears
registration. The SDK does not delete the platform's token.

Errors use stable codes, without native/server error text. Storage problems use
`storage_failure`, `storage_timeout`, `invalid_storage`, `storage_corrupt`,
`missing_storage_key` or `missing_credentials`. Native reads use `adapter_failure`
or `adapter_timeout`. `scope_mismatch` requires an explicit configuration recovery.
Failed analytics preserve the last acknowledged installation snapshot. Pending
identity transitions hide the previous installation; a user ID represents local
intent until the operation succeeds. Operations reject `binding_changed` if local
intent and server binding differ. Retry identity reconciliation before proceeding.

## Scope and key rotation

The scope includes API origin, publishable key, app ID, platform and environment.
A changed value cannot reuse the same `storageKey` silently. The client preserves
existing data and returns `scope_mismatch`.

For a planned key rotation or endpoint move, keep the old configuration available
long enough to complete `reset()` under it. Dispose that client, then explicitly
choose a new storage namespace for the new configuration. Identify through the
application and obtain product consent again. This creates a fresh installation.
If the old configuration no longer works, stop automatic recovery. The deployment
owner must first arrange revocation of the old installation with valid project
authority. A fresh namespace alone does not disable the old server registration.
There is no automatic project migration, credential overwrite or forced storage wipe.

## Expo setup

The example pins Expo 57.0.20, React Native 0.86.3, React 19.2.3,
expo-notifications 57.0.17, expo-secure-store 57.0.3, expo-crypto 57.0.2 and
expo-dev-client 57.0.18. These match Expo's bundled-native-module metadata.
Both adapters also need `react-native-mmkv` 4.3.2 and
`react-native-nitro-modules` 0.37.1. Install them and rebuild the native development
client; they are not available in Expo Go.

Install the SDK and compatible Expo modules in your app. Configure the
`expo-notifications` and `expo-secure-store` plugins, then rebuild a development
client. For Android, supply your Firebase `google-services.json` using
`android.googleServicesFile`. For iOS, enable Push Notifications and match your
bundle ID, signing entitlement, provider topic and APNs environment. The Galinum
`environment` value must match that entitlement.

The adapter uses `getDevicePushTokenAsync`, yielding APNs on iOS and FCM on Android.
It does not use Expo Push Service tokens. Its Android channel is created only when
requesting permission. The channel is native setup; the client advertises no
rendering/action capabilities. Push use requires a development build, not Expo Go.
See [Expo Notifications](https://docs.expo.dev/versions/latest/sdk/notifications/),
[SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/) and
[Crypto](https://docs.expo.dev/versions/latest/sdk/crypto/).

## Bare React Native setup

Import `createBareAdapter` from `@galinum/react-native/bare` instead of the Expo
adapter. Expo modules are optional peers and are not imported by this entry point.
The core entry point imports neither adapter.

The checked dependency set is React Native 0.86.3 with React 19.2.3,
`@react-native-firebase/app` and `@react-native-firebase/messaging` 26.4.0,
`react-native-keychain` 10.0.0, `react-native-get-random-values` 2.0.0 and
`react-native-permissions` 5.6.1. Install those exact versions for the documented
path, plus MMKV 4.3.2 and Nitro Modules 0.37.1, then run CocoaPods installation
and rebuild the native app. Node tooling requires >=20.19.0; this workspace uses
Node 24.

1. Register Android/iOS applications in Firebase with matching package/bundle IDs.
   Add `google-services.json` to `android/app` and apply the Google Services Gradle
   plugin. Add `GoogleService-Info.plist` to the iOS target. Initialize Firebase in
   AppDelegate according to the [React Native Firebase setup](https://rnfirebase.io/).
   Configure static frameworks and `$RNFirebaseAsStaticFramework = true` in Podfile.
2. Enable iOS Push Notifications. Add the `Notifications` handler using
   `setup_permissions(['Notifications'])` in Podfile, with the permissions setup
   script loaded. Set Android target SDK to at least 33 and declare
   `android.permission.POST_NOTIFICATIONS` in AndroidManifest.xml. See
   [react-native-permissions setup](https://github.com/zoontek/react-native-permissions).
3. Install MMKV, Nitro Modules, keychain and random-value modules through autolinking and
   CocoaPods. No custom native storage or randomness implementation is needed.
   See [MMKV installation and encryption](https://github.com/margelo/react-native-mmkv),
   [Keychain](https://oblador.github.io/react-native-keychain/docs/usage/) and
   [get-random-values](https://github.com/LinusU/react-native-get-random-values).
4. To defer Firebase identifier generation and APNs registration, set
   `messaging_auto_init_enabled: false` and
   `messaging_ios_auto_register_for_remote_messages: false` under `react-native`
   in `firebase.json`. The adapter explicitly registers APNs when token access is
   eligible. It calls `getToken` explicitly on Android. Firebase collection settings
   remain app-owned; Galinum consent controls Galinum token synchronization.

Current Expo SecureStore documentation warns that native platforms can reject
large values; it does not specify a current universal 2048-byte limit. The small
secret/bulk-state split avoids depending on such a limit. MMKV native encryption,
large-record persistence and power-loss behavior still require device verification.

The bare adapter reads APNs via `getAPNSToken()` on iOS, not its FCM registration
token. On Android it uses `getToken()`. Refresh callbacks are detached on session
change. On iOS, a Firebase token refresh triggers an APNs reread; call `syncDevice()`
on foreground return to catch APNs-only changes. RN Firebase can report the device
as registered while its current APNs token is null. Registration is not proof that
a token exists. Such null reads and listener rereads are treated as unavailable. The permissions library cannot
distinguish first-request and denied notification state on Android, so both map
to `denied` until authorization succeeds.

React Native Firebase skips APNs registration on ARM64 iOS simulators and can
return `messaging/registration-timeout`. A physical iOS device is required for
this bare adapter's actual APNs registration proof. See its
[messaging guidance](https://rnfirebase.io/messaging/usage).

This package configures no message handlers, background handlers, notification
presentation or navigation.

## Native text regression

On macOS, run `pnpm --filter @galinum/react-native test:native-text`. This compiles
the production UTF-8 binding/read helper against Foundation and SQLite. It proves
that embedded-NUL event IDs remain distinct, with negative controls reproducing
the old truncation collision. It does not substitute for an iOS SQLCipher build.
