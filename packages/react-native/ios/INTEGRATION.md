# iOS notification carrier

Use the `GalinumJournal` notification and feedback ports. There is no separate
carrier JavaScript module or interaction store. Interactions and feedback use the
application's encrypted journal. The installation client remains the only HTTP
sender and the owner of raw APNs tokens.

Expo applications list `@galinum/react-native` in their config plugins. Prebuild then
adds the receipt pod next to the autolinked journal and runs CocoaPods installation.
Bare applications add the pod to the application target in their Podfile:

```ruby
pod 'GalinumReceiptStore', :path => '../node_modules/@galinum/react-native'
```

Use the actual installed package path if the application uses a monorepo, then run
`pod install` and rebuild. The receipt pod contains no React Native dependencies.
Neither setup edits the application delegate.

The carrier composes the existing `UNUserNotificationCenter` delegate. It initializes
the installed Expo notification manager before taking the delegate slot. In a bare
application, initialize other notification libraries first. If the application sets
its own delegate later, call `[GalinumNotifications install]` after that assignment.
Non-Galinum notifications pass to the previous delegate. Galinum responses enter the
journal once; named actions open the foreground application. This integration does
not replace APNs registration callbacks or token listeners.

The journal persists foreground presentation and category composition. The default
is `display`; `suppress` still records a valid receipt. Configuration does not request
permission. Existing application categories remain registered. Use category IDs
that do not belong to another notification library.

Foreground handoff checks the current publication, identity, consent, OS permission,
and memory restriction fence. The carrier cannot retract a notification already
presented by the operating system. Background remote alert presentation remains
controlled by iOS.

## Optional notification service extension

Create a Notification Service Extension target. Add only `GalinumReceiptStore` to
that target. Subclass `GalinumNotificationService` and use that subclass as the
extension principal class. Include the extension in the application target.

Configure `GalinumReceiptAppGroup` and `GalinumReceiptKeychainGroup` in both targets'
Info.plists, with matching dedicated App Group and Keychain Sharing entitlements.
Set `GalinumNotificationService` to `YES` in the extension Info.plist. The groups must
be dedicated to receipts. Do not put installation credentials or journal keys in them.

The application creates a separate device-only receipt key. The extension can write
immutable AES-GCM authenticated receipt files and download HTTPS images. It cannot
open the application's journal or send installation API requests. The application
imports each receipt ID once in a journal transaction, then removes its file.

The extension accepts JPEG, PNG and GIF images up to 5 MiB. Download failures,
unsupported media, missing receipt configuration and extension expiration preserve
the original notification text. Rich-image capability requires a matching embedded
extension and successful receipt-key setup. Provider acceptance does not establish
extension execution, presentation, or receipt delivery.
