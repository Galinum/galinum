# Galinum verification map

This map covers the primary product surface: the public management API used by customer agents and the browser SDK API used by customer products. The cloud dashboard supervises the same state but is not part of this isolated harness.

## Baseline preconditions

- Run commands from the `galinum` repository root.
- Use Node 24 through `fnm exec --using=24`.
- Keep the product checkout on the same commit and worktree state during a run.
- Launch one fresh in-memory server for one scenario.
- Require `control-galinum doctor` to pass before driving.
- Never supply `DATABASE_URL`, cloud credentials, or production endpoints.

## Driving conventions

- Treat each scenario command as literal.
- Use a unique run ID for every scenario.
- Use secret-key routes only for management actions.
- Use publishable-key routes only for browser SDK actions.
- Let the helper redact key values from transcripts.
- Read the feature recipe before running its scenario.

## Proof and skip reporting

- Require the HTTP transcript and the successful proof JSON.
- Capture each write and a public read that confirms its effect.
- Keep dynamic campaign, segment, delivery, goal, and user IDs in the proof file.
- Report a failed step with its response status and retained transcript path.
- Do not report another entry point as verified when its feature scenario did not run.
- Run cleanup after success or failure and retain all evidence.

## Feature entry contract

Each feature file describes one user-visible API workflow. Its drive section names the exact scenario and the ordered HTTP actions that the helper records.

## Features

- [Campaign lifecycle](./campaign-lifecycle.md) covers draft creation, reads, status filters, launch, pause, relaunch, and end.
- [Audience matching](./audience-matching.md) covers observed vocabulary, exact counts, samples, and per-user explanations.
- [Segment versioning](./segment-versioning.md) covers creation, optimistic concurrency, immutable history, and archive.
- [Web in-app delivery](./web-inapp-delivery.md) covers goal linkage, eligibility, impression feedback, conversion, and delivery evidence.
- [Users, events, and metrics](./users-events-metrics.md) covers SDK ingestion and management-side user, event, overview, metrics, and usage reads.
