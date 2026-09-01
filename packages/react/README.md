# @galinum/react

React SDK for [Galinum](https://galinum.com), self-driving product
communications. Identify users, track events, and render in-app messages.
The product team's agent creates and targets the campaigns through the
management API. This SDK is the web in-app delivery surface.

## Install

The SDK ships as a tarball in each Galinum product release. Install the
tarball your release provides:

```bash
npm install ./galinum-react-<version>.tgz
```

`react >= 18` and `react-dom >= 18` are peer dependencies.

## Usage

Wrap your app in the provider with your project's **publishable key** (safe to
ship in the browser), then drop `<InAppMessages/>` anywhere near the root.

```tsx
import { GalinumProvider, InAppMessages, useGalinum } from "@galinum/react";

export function App() {
  return (
    <GalinumProvider
      publishableKey="pk_pub_xxx"
      apiBase="https://galinum.com"
      userId={currentUser?.id}
    >
      <YourApp />
      <InAppMessages />
    </GalinumProvider>
  );
}
```

### Identify & track

```tsx
const { identify, track } = useGalinum();

await identify("user_123", { plan: "free", country: "US" });
await track("activated_workspace", { workspaceId: "ws_1" });
```

`identify` sets the current user (also settable via the `userId` prop). `track`
records a behavioral event Galinum's agents analyze to decide who sees what.

### Auto-collected context

Like other analytics SDKs, `identify()` automatically attaches device and
demographic context as `$`-prefixed traits, so they never collide with yours:

- `$browser`, `$browser_version`, `$os`, `$os_version`, `$device`,
  `$device_type` (Desktop / Mobile / Tablet) — parsed from the user agent
- `$timezone`, `$language`, `$screen_width`, `$screen_height`
- `$referrer`, `$referring_domain` (when present)
- `$lib`, `$lib_version`
- `$country`, `$region`, `$city` — enriched **server-side** from the request IP

`track()` attaches `$current_url` and `$pathname` to each event. Explicit
traits/props always win over auto-collected values on key collisions. Opt out
entirely with `<GalinumProvider autoContext={false} …>`.

### One message per page view

Eligible messages are **prefetched** when the user is identified and cached in
memory. Each page view then decides synchronously from that cache, so no
network request sits on the render path and no message pops into a screen the
user is already reading.

- A user sees at most one message per page view, across every mounted
  `<InAppMessages/>`.
- Messages appear at page load or right after a navigation. Nothing appears
  mid-screen.
- Dismissing a message does not release the page view. Navigation is the only
  unlock.
- A message still on screen when the user navigates simply leaves. It sends no
  dismissal, so the same message can appear again on a later page view.
- Campaigns may target screens: a campaign with `pages` patterns renders only
  on matching paths. A pattern starts with `/`, `*` matches any characters,
  and matching is case-sensitive against the pathname (query and hash are
  ignored).

Images are warmed in the background and each message reserves its image area,
so a slow image never delays the text or shifts the layout.

### Default rendering: toast or announcement modal

Each message states its presentation in `content.presentation`:

- **`"toast"`** — a compact card fixed to the bottom-right corner (title,
  body, optional CTA button). With `content.media`, the image renders as a
  small thumbnail inside the card.
- **`"modal"`** — a large centered announcement over a full-viewport
  backdrop: the image on top as the visual focus, then title, body, and a
  prominent CTA. Desktop gets a constrained card (~480 px); mobile is
  near-full-width and viewport-safe. Animated GIFs animate. A modal without
  media renders text only.

Media is content, not presentation. Messages delivered by Galinum always
carry `presentation`; a cached or older payload without it falls back to the
server's rule (media → modal, no media → toast).

The modal is an accessible dialog: initial focus moves into it, Tab stays
inside, it closes via the close button, Escape, or a backdrop click, and
focus returns to the host page afterwards. Image `alt` comes from the
campaign (`media.alt`, or empty when marked `decorative`); if the image
fails to load, the text and dismissal controls still work. Only one message
is on screen at a time; a modal outranks a toast when both are eligible for
the same page view. All presentation is inline styles: the SDK injects no
stylesheets (inherited properties like `font-family` still apply).

#### Theming

The default renderer ships a light and a dark palette. `theme` selects it:
`"light"`, `"dark"`, or `"auto"` (the default).

`"auto"` reads the computed `color-scheme` of your `<html>` element — the
standard way a page declares its scheme — and looks at its keywords:

- `dark` without `light` (`dark`, `only dark`) → dark palette.
- both keywords (`light dark`, `dark light`) → follows the OS
  `prefers-color-scheme`.
- no `dark` keyword → light palette.

The palette follows later changes too, so your theme toggle flips the message
live. If your app switches themes without setting `color-scheme`, pass the
value yourself:

```tsx
<InAppMessages theme={isDark ? "dark" : "light"} />
```

A custom `render` is unaffected: `theme` styles only the built-in toast and
modal.

### Custom rendering

Pass `render` to fully control the UI while Galinum handles targeting,
variant assignment, and measurement (`message.content.media` is
`{ url, alt?, decorative? }` and `message.content.presentation` is
`"toast"` or `"modal"` — use or ignore it as you like):

```tsx
<InAppMessages
  render={(message, actions) => (
    <MyToast
      title={message.content.title}
      onCta={actions.onClick}
      onClose={actions.onDismiss}
    />
  )}
/>
```

The scheduler governs custom renderers too: `render` receives the one message
scheduled for this page view. Return `null` to render nothing — no impression
is recorded and the next matching message takes its place.

Impressions are counted on actual render, not on fetch: when your `render`
function returns content for a message, the SDK reports `shown` for that
delivery automatically. `actions.onClick` /
`onDismiss` / `onConvert` report back to Galinum so the autonomous optimizer
can measure impact. If you fetch messages through the API yourself instead of
using `<InAppMessages/>`, send `{ "type": "shown" }` to the delivery feedback
endpoint when the message is actually displayed — otherwise it never counts
as an impression.

## API surface

- `GalinumProvider` — `{ publishableKey, apiBase?, userId?, traits?, autoContext? }`
- `useGalinum()` — `{ identify, track, reset, sendFeedback, waitForTracks, waitForIdentify, userId, config }`
  - `reset()` clears the identified user on logout.
  - `waitForTracks(timeoutMs?)` resolves once the `track()` requests that were
    in flight when you called it have settled (or after the timeout, 2s by
    default). `<InAppMessages/>` awaits it before every fetch so event-based
    targeting normally sees the events your app just fired; a stalled track
    can only delay a fetch up to the timeout, never block it.
  - `waitForIdentify()` resolves once the current user's `identify()` request
    has settled. The first message fetch awaits it, so a brand-new user is
    never queried before the server knows them.
- `<InAppMessages />` — `{ theme?, render? }`

`identify`/`track` never throw — failed requests are swallowed (logged in dev).
The components are client-only (`"use client"`); render them inside a Client
Component in the Next.js App Router.

## Development

This package lives in the Galinum product monorepo. Consumers need Node 20 or
later, as declared in `engines`. Repository development uses the Node and pnpm
versions pinned in the root `package.json`.

From the repository root:

- `pnpm --filter @galinum/react test` runs the Vitest suite on happy-dom with
  Testing Library.
- `pnpm --filter @galinum/react build` compiles `dist`.

The Next.js example in [`examples/react-nextjs`](../../examples/react-nextjs)
consumes this package through the workspace.

License: Apache-2.0
