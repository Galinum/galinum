# Native in-app integration contract

`src/inapp-types.ts` defines the ports. `getInAppController` returns one authority per stable client-port object. Keep that object and controller at client lifetime, outside renderer components. Dispose only when the client owner ends. Never construct a new wrapper per host or render.

## Session authority

`owner` identifies the current process/client owner. `userId` captures application identity. `facts` is a monotonic invocation revision. Increment it synchronously when identify or track is invoked, including same-user calls, before storage, initialization, or HTTP waits. Publish the subscription in that same invocation. A revision change invalidates pending decisions and selected candidates that have not committed. Once committed or settled empty, same-user fact changes cannot reopen that entry. Committed actions remain valid for the same confirmed owner and user; account, owner, readiness, or foreground changes close them.

`appConfirmed` starts false for every new owner, even when installation state rehydrates as ready. It becomes true only after the application confirms its current identity and reconciliation completes. Close it at identity-change invocation and on incomplete reconciliation. A persisted snapshot cannot restore this authority. Neither push consent nor notification permission gates in-app messages.

Mount one `InAppLifecycle` at the stable application/navigation boundary. Pass the router's current entry key, logical path, and explicit `navigationReady`. The lifecycle forwards real AppState foreground transitions. Renderer mount/unmount does not create a navigation entry. Re-rendering the lifecycle with unchanged inputs also does not create one. Application teardown must dispose its controller.

Readiness changes alone do not create an entry. Losing readiness closes an existing entry, cancels uncommitted selection, and removes its presentation. Restoring readiness on the same key and normalized path cannot retry that entry or restore its presentation. If no entry has started, readiness permits its initial decision. A changed route key or path, a new foreground entry, or a changed session authority can start fresh selection.

`decide(input, signal)` waits for preceding identify/track work and checks the captured owner/invocation revision before issuing the existing public GET. Use userId, entryId, requestId, and path from the input, with no-store semantics. Return the echoed userId, entryId, requestId and messages. Never substitute cached eligibility. Reject failed responses. The controller rejects correlation mismatch, stale completion, and results after its deadline, even when transport ignores abort.

`options.id()` supplies collision-resistant IDs across process restarts. Use the native adapter's UUID/random facility; never use the deterministic test counter. `openDestination` receives a validated typed destination after durable clicked admission. It implements website/application dispatch and any optional app navigation policy. Configured app schemes remain explicit; HTTPS websites need no mandatory origin list.

## Canonical journal feedback

`isCompleted(userId, deliveryId)` reads the existing native journal's durable completion state. A read failure prevents selection. No renderer-owned persistent store exists.

`admit(input)` resolves `queued` only after durable admission. Preserve the exact userId, deliveryId, type, feedbackId, and shownFeedbackId on uncertain retries. Terminal admission requires the matching durable shown predecessor. Atomically persist terminal admission and local completion. Failed storage must reject; it cannot return a queued receipt.

The journal sender must acknowledge shown before submitting its dependent terminal request. This shares the journal's local ordering boundary with dependent business events, without assigning feedback an observation sequence. Keep the original captured user through reset and restart. Never rebind old feedback to the current identity.

Validate the complete canonical receipt tuple: userId, deliveryId, type, receiptId equal to feedbackId, and a valid acknowledgedAt. Persist the validated acknowledgement before returning `acknowledged`. A wrong tuple, malformed success body, or failed acknowledgement write remains pending. An HTTP success alone is not acknowledgement. `flush()` retries this existing journal; it must not create a second sender or store.

React commit consumes the entry slot. Native toast/custom layout or modal onShow admits shown. Merely selecting content does not mutate feedback. Unmounting after commit does not transfer the slot, even when its native presentation callback has not arrived. Terminal actions require presentation confirmation and remain bound to their exact host and candidate. A skipped custom renderer cannot act on its successor. Custom render functions must return null, undefined, or false to skip a candidate; otherwise they must return visible native content. An empty child component does not signal a skip. Failed admission retains the message and exposes retry. Repeated retries keep exact IDs. No component fixture establishes journal persistence, receipt verification, or native device behavior.

## Integration status and verification

These modules define a renderer and controller port contract. The package client,
provider, public exports, and durable native journal do not yet connect these ports.
The in-memory feedback fixture does not establish durable client integration.

After `pnpm install --frozen-lockfile`, run `pnpm check:native` from the checkout
root with Node 24 and pnpm 10.15.0. This builds server dependencies, then runs the
native package typecheck, Vitest suite, Jest renderer suite, build, package check,
and Expo example typecheck and build. The package `test` command runs both suites.
The explicit `.jest.cjs` match keeps the renderer suite in Jest discovery.

To save source hashes, installed versions, build artifact hashes, and complete
normal gate output outside the checkout, run:

```sh
pnpm exec node packages/react-native/test/inapp-proof.mjs --output ../native-gate-evidence.json
```

Jest uses the official React Native preset and Babel transform from pinned
workspace dependencies. The suite uses official native-module mocks and explicit
layout, modal, image-error, and AppState callbacks. Its feedback port is an
in-memory double. It verifies controller ordering and failure handling. It does
not verify SQLCipher persistence, process recovery, native callback timing, GIF
playback, accessibility focus, safe-area placement, or device navigation.
