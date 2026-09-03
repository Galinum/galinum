# Segment versioning

Segment versioning lets a customer's agent create a reusable audience, replace its expression safely, inspect immutable history, and archive it.

## Sub-features

- `segment-create` creates an active segment at version 1.
- `segment-revise` replaces the expression with an expected version.
- `segment-stale-write` rejects a conflicting update.
- `segment-history` lists and reads immutable versions.
- `segment-archive` retires the segment from new selection.

## How to get to it (user POV)

- Create and list through `/api/v1/segments` with the secret key.
- Read or revise through `/api/v1/segments/{id}`.
- Read history through `/api/v1/segments/{id}/versions` and `/versions/1`.
- Archive through `POST /api/v1/segments/{id}/archive`.

## Driving it with control-galinum

Preconditions:

- A fresh run passes doctor.
- The generated segment key does not exist because the run has empty state.

- **Drive.** Run `fnm exec --using=24 -- node .agents/skills/verify-galinum/scripts/control-galinum.mjs scenario "$GALINUM_VERIFY_RUN_ID" segment-versioning`.
- **Create.** Step 1 creates a free-plan segment. Status `201` returns `currentVersion: 1`.
- **Revise.** Step 2 replaces the expression with enterprise-plan matching and `expectedVersion: 1`. The segment advances to version 2.
- **Reject stale state.** Step 3 repeats an expression write with `expectedVersion: 1`. Status `409` reports `currentVersion: 2`.
- **Read history.** Steps 4 and 5 list versions `2, 1`, then read version 1. The original free-plan expression remains unchanged.
- **Archive.** Steps 6 and 7 archive the segment, then list archived segments. The generated ID appears with `status: archived`.
- **Preserve and reject.** Steps 8 and 9 read version 1 after archive, then require `409` when a new campaign selects the archived segment.
- **Proof.** Require `segment-versioning.http.txt` and `segment-versioning.proof.json`. The proof records the segment ID, version order, conflict status, final state, retained history, and archived-selection rejection.

## Gotchas

- Expression replacement requires `expectedVersion`. Metadata-only edits do not.
- A stale write must return `409`. Do not treat a later successful read as conflict proof.
- Archive is not delete. Version history must remain readable.
- Run IDs contribute to segment keys. Keep the run ID within the skill's length limit.
