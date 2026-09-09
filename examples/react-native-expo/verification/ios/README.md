# iOS journal and notification verification

This fixture has two JavaScript entries. `index.js` drives the journal TurboModule
directly for kernel, notification, feedback, and event-emitter methods without any
HTTP server. `integrated.ts` runs the actual `createGalinumClient`, Expo adapter,
notification handler, HTTP sender and in-app renderer against a disposable loopback
Galinum server. `JournalHarness` supplies only native OS ingress, fault injection,
inspection, and evidence persistence. Neither entry contacts a push provider.

Use Node 24 and pnpm 10.15.0. From the example root, prebuild iOS, prepare the
fixture, then install Pods:

```sh
pnpm exec expo prebuild --platform ios --no-install
ruby verification/ios/prepare.rb
(cd ios && pod install)
```

The Galinum config plugin adds the receipt pod during prebuild. `prepare.rb` adds
the harness pod, points the debug AppDelegate at the embedded `main.jsbundle`,
removes the app target's `EXPO_CONFIGURATION_DEBUG` Swift flag so the development
launcher does not intercept the fixture, sets this directory's simulator-only
`Simulator.entitlements`, copies the receipt group keys from `service/Info.plist`
into the app Info.plist, adds the notification service extension target, adds the
`GalinumVerificationUITests` UI driver target and scheme, and writes
`.xcode.env.local` so the Debug build embeds a production-mode `integrated.ts`
bundle. A development-mode bundle fails at startup because the embedded runtime
has no Metro devtools socket. Set `ENTRY_FILE` to `verification/ios/index.js`
there to embed the kernel entry instead.

The extension has its own simulator identity and shares only the receipt group. It
compiles the real receipt/service source without React Native or the journal.

Build the workspace's GalinumNativeFoundation scheme for an arm64 iOS simulator,
with `CODE_SIGNING_ALLOWED=YES` and `CODE_SIGN_IDENTITY=-`. Build the
`GalinumVerificationUITests` scheme with `build-for-testing`. Install only on the
assigned disposable simulator.

## Kernel entry

Run each phase from the repository root:

```sh
GALINUM_RECEIPT_PROOF=1 node examples/react-native-expo/verification/ios/run-phase.mjs DEVICE PHASE OUTPUT
```

Use one OUTPUT directory for the complete sequence. It determines an isolated
journal scope and installation identity. Start with `permission` and accept the
fixture's notification prompt once. Then run `seed`, `kernel`, `feedback`, `reopen`,
`receipts`, `notifications`, `composition`, `cold-ingress`, and `identity` in order.
Each phase terminates the previous process and saves its PID, assertions, and native
trace. Use a new OUTPUT directory for another full run; existing bytes remain intact.

`notifications` posts real local notifications and pauses the native handoff before
restriction. `composition` uses the installed Expo delegate and a bare host delegate
fixture. `cold-ingress` captures a named action with no attached JS owner; it does
not simulate an OS tap. `receipts` tests actual App Group ciphertext, authentication,
import through sender peek, and repeated receipt-ID import.

The extension is built and embedded. Its service class's text fallback runs in the
app harness. These checks do not prove OS extension invocation, provider delivery,
physical-device token handling, or application router/HTTP sender integration.
Shutdown the assigned simulator after verification.

## Integrated entry

`integrated.ts` reads `Documents/journal-config.json` with `phase`, `origin`,
`publishableKey`, `appId`, `token`, `storageKey`, optional `foreground`, and the
server `reference` or `deliveryId` for the phase. It writes `journal-<phase>.json`
with `verified`, the handled interactions, the HTTP transcript and the process ID.
Phases are `seed`, `cold`, `warm`, `suppress`, `revoked`, `old-user`,
`inapp-terminal` and `inapp-completion`. The host driver owns a disposable
`verify-galinum` server, substitutes only the APNs token read, creates campaigns
through the public management API, compiles the server's APNs payload, delivers it
with `simctl push`, and uses the UI driver target for the OS tap, the long-press
action, the permission prompt and the in-app call to action. `cold` must start
from a terminated process through the OS tap. Foreground presentation, delivered
notification lists and feedback counters come from real OS and server reads.
The in-app phases cover the default modal with a PNG, a dark toast with a GIF that
is dismissed, and a custom renderer; each terminal feedback is confirmed through
the campaign counters and a fresh web entry.

The UI driver reads `GALINUM_UI_MODE` (`alert-allow`, `notification-tap`,
`notification-action`, `app-tap`), `GALINUM_UI_LABEL`, `GALINUM_UI_ACTION`,
`GALINUM_UI_APP`, `GALINUM_UI_TIMEOUT` and `GALINUM_UI_RESULT` from the test
runner environment. `simctl push` is not APNs delivery, and none of this proves
extension process execution or physical-device token handling.
