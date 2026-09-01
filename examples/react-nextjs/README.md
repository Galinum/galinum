# Galinum React SDK Next.js example

Minimal Next.js App Router setup for `@galinum/react`. It also serves as the
development harness for SDK changes.

## What it shows

- `GalinumProvider` with a publishable key + API base
- `useGalinum()` — `identify` / `track` / `reset`
- `<InAppMessages/>` prefetching messages and showing one per page view, with
  feedback (clicked / dismissed) reported back automatically
- Screen links (`/`, `/settings`, `/settings/billing`, `/reports`) for testing
  navigation unlocks and campaign `pages` targeting

## Run it against a local server

Start a Galinum server that serves the public SDK routes. The self-host
example in [`examples/self-host`](../self-host) starts one on
http://localhost:3000.

1. Copy your project's publishable key (`pk_pub_…`) from that server.

2. Put the key in this app's `.env.local`:

   ```bash
   NEXT_PUBLIC_GALINUM_PUBLISHABLE_KEY=pk_pub_...
   ```

   Make sure a running campaign exists.

3. From the repository root, build the SDK and start this example:

   ```bash
   pnpm install
   pnpm --filter @galinum/react build
   pnpm --filter @galinum/example-react-nextjs dev
   ```

4. Open http://localhost:3001 and identify a fresh user id. Running campaigns
   that user is eligible for appear on the next page view.

Deliveries are deduped per campaign and user. Once a user dismisses a
campaign, that user does not see it again. Use a fresh user id to trigger it
again.

This example consumes the SDK through the pnpm workspace. Rebuild the SDK
after each source change to pick it up here.

## Point it elsewhere

Defaults target the local development setup. Override them in `.env.local`:

```bash
NEXT_PUBLIC_GALINUM_PUBLISHABLE_KEY=pk_pub_...
NEXT_PUBLIC_GALINUM_API_BASE=https://galinum.com
```
