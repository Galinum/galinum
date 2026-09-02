# Users, events, and metrics

Users, events, and metrics let a customer ingest product activity through the SDK and inspect it through management reads.

## Sub-features

- `users-identify` stores external user IDs and merged traits.
- `users-filter` filters users by an observed trait.
- `user-detail` reads the stored user and traits.
- `events-track` records named events and properties.
- `events-filter` filters event history by name and user.
- `project-overview` reports all users and recent event totals.
- `project-metrics` reports event totals and activity state.
- `project-usage` reports current active users.

## How to get to it (user POV)

- Ingest through `/api/v1/identify` and `/api/v1/track` with the publishable key.
- Browse through `/api/v1/users`, `/api/v1/users/{id}`, and `/api/v1/events` with the secret key.
- Read aggregate state through `/api/v1/overview`, `/api/v1/metrics`, and `/api/v1/usage`.

## Driving it with control-galinum

Preconditions:

- A fresh run passes doctor.
- No users or events exist in the run.

- **Drive.** Run `fnm exec --using=24 -- node .agents/skills/verify-galinum/scripts/control-galinum.mjs scenario "$GALINUM_VERIFY_RUN_ID" users-events-metrics`.
- **Identify.** Steps 1 and 2 create free and pro users with different regions.
- **Track.** Steps 3 and 4 record activation and export events with properties.
- **Filter users.** Step 5 filters `plan=free`. It returns only `verify-user-one`.
- **Read detail.** Step 6 reads the generated Galinum user ID. The stored region is `south`.
- **Filter events.** Step 7 filters activation events for `verify-user-one`. It returns the `source: verification` property.
- **Read aggregates.** Steps 8-10 report two users, two recent events, two metric events, and two active users.
- **Proof.** Require `users-events-metrics.http.txt` and `users-events-metrics.proof.json`. The proof records user, event, and usage totals.

## Gotchas

- Management user detail accepts the generated Galinum ID used by this scenario.
- Event filters use the external user ID parameter.
- Overview uses a rolling time window. Drive it immediately after ingestion.
- Metrics and usage measure different concepts. Assert both when activity affects billing or supervision.
