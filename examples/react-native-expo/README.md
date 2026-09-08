# Native foundation example

This disposable Expo app exercises the native installation client. It does not
implement push display, notification interaction routing or in-app UI.

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

Add the Android Firebase file through `android.googleServicesFile` and configure
iOS signing with the matching bundle ID and development APNs entitlement. Rebuild
with `pnpm exec expo run:android` or `pnpm exec expo run:ios` from this directory,
using only a disposable device selected for your task. Native generated folders
are ignored. The source includes no provider credentials.

For a configured development client, run `pnpm start`. Identify A, enable consent,
request permission, synchronize, and explicitly record foreground activity. Reset
and identify B. Confirm consent is false and A's activity is absent. Compare the
acknowledged snapshot to the management installation endpoint. The example never
prints the capability or native token.

The app also includes MMKV and Nitro Modules for encrypted operational storage.
Rebuild the development client when adding these dependencies. Verify secure storage,
large records, process death and reinstall behavior on task-owned devices separately.

Permission and token checks need native modules and provider configuration. Expo
Go is not a substitute. See the [SDK setup](../../packages/react-native/README.md)
for the Expo and bare dependency sets and native setup requirements.


## Embedded journal verification

The `verification/` fixture uses the actual native journal and JavaScript client.
After Android prebuild, run `node verification/prepare.mjs`, then build
`:app:assembleJournalVerification` in the generated Android project. It uses a
unique application ID, an embedded Hermes bundle and a verification-only native
source set. That source set is not included in the SDK package.

The host driver must provide private runtime configuration in the app sandbox.
It controls only a disposable server and an explicitly selected disposable device.
The fixture substitutes permission/token/channel facts and injects a native tap
through the internal ingress boundary. This proves journal and HTTP order, not
notification delivery, OS receiver routing or production channel setup. It also
checks actual process reopen, uncertain-prefix replay and database pressure.
