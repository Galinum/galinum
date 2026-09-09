# React Native Expo example

This disposable Expo app exercises installation, notification interaction routing,
and shared web/native in-app messaging. Its lifecycle uses the root screen path
`/` and one client-owned controller. The app shows received tap/action details;
connect your own router when adding application navigation.

Use Node 24 and the workspace's pnpm 10.15.0. From the repository root:

```sh
pnpm install
pnpm check:native
```

`check:native` runs the client's real loopback HTTP tests, adapter mapping and React
hook tests, typechecks, packed-export checks, and Metro/Hermes exports for iOS and
Android. A bundle export is not a native application build or device delivery proof.

Start the local server with a known development publishable key. Configure
`extra.galinumApiBase` and `extra.galinumPublishableKey` in `app.json`. Android
emulators normally reach the host at `http://10.0.2.2:3000`; iOS simulators can use
`http://127.0.0.1:3000`. Physical devices need a reachable HTTPS development origin.
Bind the disposable local server appropriately for your emulator network.

Place the Android Firebase client file at `google-services.json` beside
`app.config.js`; the config sets `android.googleServicesFile` when that file exists.
Configure iOS signing with the matching bundle ID and development APNs entitlement. Rebuild
with `pnpm exec expo run:android` or `pnpm exec expo run:ios` from this directory,
using a development device. Native generated folders
are ignored. The source includes no provider credentials.

For a configured development client, run `pnpm start`. Use the app controls in
this order:

1. Identify a user with your application's external user ID.
2. Enable product consent through its separate control.
3. Request notification permission after your permission explanation.
4. Refresh permission and token, then record foreground activity during actual use.
5. Compare the acknowledged snapshot with `GET /api/v1/installations` on the server.

Initialization never prompts or grants consent. The example never prints the
installation capability or native token. Reset before switching the example user.
A different user starts without the previous user's consent or activity.

Create campaigns through the management API. For Android push, use app ID
`com.galinum.nativefoundation`, environment `development`, channel `updates`, and
registered action IDs `open` or `later`. Match the app ID to `app.json` if you
change it. Configure iOS categories before using iOS action campaigns.
Keep APNs and FCM server credentials on the server.

Use a selected-device test within your send authority. Persist its request ID and
read it back after an uncertain response. Inspect provider acceptance, SDK receipt,
and the displayed content separately. A tap opens this example and shows its
captured interaction after explicit identification. See the
[push guide](https://docs.galinum.com/push) for correlated inspection and attribution.

For in-app content, use `channel: "web_inapp"` with a `pages` pattern matching `/`.
The renderer supports modal and toast messages, managed images, automatic themes,
and shared completion. It takes a fresh decision on a new screen entry or
foreground return. Custom rendering and router integration use the same controller;
see the [SDK guide](https://docs.galinum.com/sdk/react-native#render-in-app-messages).

The app includes MMKV and Nitro Modules for old-format detection. Operational state
and feedback use the native SQLCipher journal. The additional Firebase, Keychain,
permissions and randomness modules support the bare-adapter verification variant.

Permission and token checks need native modules and provider configuration. Expo
Go cannot load the native journal. See the [SDK setup](../../packages/react-native/README.md)
for the Expo and bare dependency sets and native setup requirements. The Expo
plugin inserts the separate iOS receipt pod. Optional iOS notification images
also need an extension target and dedicated receipt groups.

Android GIF in-app media needs Fresco animation support. Keep
`expo.gif.enabled=true` in the generated Android properties and rebuild. A pure
bare React Native 0.86.3 app adds `com.facebook.fresco:animated-gif:3.6.0` to its
Gradle dependencies. That dependency does not animate Android notification images.
Bare integration uses its own adapter and requires no Expo modules.

## Embedded journal verification

The `verification/` fixture uses the actual native journal and JavaScript client.
After Android prebuild, run `node verification/prepare.mjs`, then build
`:app:assembleJournalVerification` in the generated Android project. It uses a
unique application ID, an embedded Hermes bundle and a verification-only native
source set. That source set is not included in the SDK package.

The host driver must provide private runtime configuration in the app sandbox.
It controls only a disposable server and an explicitly selected disposable device.
Storage phases substitute device facts and inject journal observations. Carrier
phases inject Firebase data messages, then exercise native notification display,
real activity PendingIntents, durable interactions and application handlers. Device
permission and token inputs remain controlled. In-app phases mount the public
renderer and use the real delivery HTTP routes and native completion journal.

For the bare-adapter variant, use `node verification/prepare.mjs --bare` after a
fresh Android prebuild and supply `carrier: "bare"` in the private runtime config.
This uses `createBareAdapter()` in the same Expo-generated host. Its manifest selects
Galinum's Firebase receiver and removes the Expo carrier and original Firebase receiver.
A private verification receiver inherits the production receiver implementation so
local injection does not require Google's sender permission. That alias is absent
from the SDK package. Neither variant proves delivery from the real FCM service.
