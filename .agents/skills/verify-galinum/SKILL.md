---
name: verify-galinum
description: Verify Galinum's self-hosted management and browser SDK HTTP API through an isolated in-memory server. Use after product API, targeting, campaign, delivery, user, event, or metrics changes need user-path proof.
---

# Verify Galinum

Drive the public API that a customer's agent and browser SDK use. The cloud dashboard is a secondary supervision surface and is outside this harness. Read [features/README.md](features/README.md) before choosing a scenario.

Run every command from the `galinum` repository root. Use a fresh run ID for each scenario. Never point this harness at Galinum Cloud, Postgres, or an existing server.

## Launch

Set a unique run ID, then build and launch the isolated server:

```bash
GALINUM_VERIFY_RUN_ID=campaign-lifecycle-01
fnm exec --using=24 -- node .agents/skills/verify-galinum/scripts/control-galinum.mjs launch "$GALINUM_VERIFY_RUN_ID"
```

`launch` builds `@galinum/server` and its workspace dependencies with the pinned pnpm install. It removes database variables from the child environment. It starts one loopback server on an unused port with fresh keys and in-memory state.

The command prints the exact origin and artifact directory. Readiness requires a successful doctor result. Do not reuse a run ID or attach this harness to another process.

## Doctor

Run this check before every drive and whenever the instance looks wrong:

```bash
fnm exec --using=24 -- node .agents/skills/verify-galinum/scripts/control-galinum.mjs doctor "$GALINUM_VERIFY_RUN_ID"
```

Doctor requires all of these facts:

- The recorded PID is alive and runs the built Galinum server entrypoint.
- That PID owns the recorded loopback port.
- `/api/health` returns `{"status":"ok"}`.
- The product commit, worktree state, and server package version still match launch.

If doctor fails, run cleanup. Then launch a fresh run. Never drive an instance that doctor rejects.

## Drive

Choose one feature scenario from the map. For example, drive campaign lifecycle:

```bash
fnm exec --using=24 -- node .agents/skills/verify-galinum/scripts/control-galinum.mjs scenario "$GALINUM_VERIFY_RUN_ID" campaign-lifecycle
```

Available scenario names are `campaign-lifecycle`, `audience-matching`, `segment-versioning`, `web-inapp-delivery`, and `users-events-metrics`.

Each scenario sends real authenticated HTTP requests to public routes. It uses secret credentials for management operations and publishable credentials for browser SDK operations. It rejects a second scenario in the same run because the in-memory state would no longer match the feature preconditions.

## Evidence

Proof survives under `.audit/verification/verify-galinum/<run-id>/`. A successful scenario writes:

- `server.log` with launch identity and runtime output.
- `<scenario>.http.txt` with each user action, redacted credential class, request body, status, and response body.
- `<scenario>.proof.json` with verified observations and dynamic resource IDs.
- `cleanup.json` with the stopped PID and retained evidence path.

Require both the transcript and `verified: true` proof file. The transcript must show the action and resulting read. A mutation is not proven by its write response alone. Confirm it through a public read route in the same scenario.

Use only the real management and SDK paths. Do not call internal handlers, setters, test-only endpoints, or the database. The in-memory adapter isolates storage but does not mock the Galinum product boundary. These scenarios do not cross email, billing, hosted-agent, or other cloud-only boundaries.

On failure, retain the transcript and failure file. Run cleanup before changing the helper or starting another attempt.

## Cleanup

Stop only the process recorded for this run:

```bash
fnm exec --using=24 -- node .agents/skills/verify-galinum/scripts/control-galinum.mjs cleanup "$GALINUM_VERIFY_RUN_ID"
```

Cleanup checks both the server command and port ownership before it sends a signal. It removes the credential-bearing runtime file. It preserves all proof artifacts.

After cleanup, confirm the proof still exists:

```bash
test -f ".audit/verification/verify-galinum/$GALINUM_VERIFY_RUN_ID/campaign-lifecycle.proof.json"
test -f ".audit/verification/verify-galinum/$GALINUM_VERIFY_RUN_ID/cleanup.json"
```

Change the proof filename when you drive another scenario.

## Helpers

The executable helper is `.agents/skills/verify-galinum/scripts/control-galinum.mjs`. Always invoke it through Node 24:

```bash
fnm exec --using=24 -- node .agents/skills/verify-galinum/scripts/control-galinum.mjs --help
```

It owns build, launch, health checks, HTTP transcripts, assertions, and teardown. Do not bypass its runtime file or manually kill its process.
