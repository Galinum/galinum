# Audience matching

Audience matching lets a customer's agent discover observed user data, evaluate an expression, inspect exact samples, and explain inclusion or exclusion.

## Sub-features

- `audience-ingest` identifies users and records event properties through publishable routes.
- `audience-capabilities` reports observed traits, events, and expression limits.
- `audience-check` canonicalizes an expression and returns exact counts and samples.
- `audience-explain-match` shows why one user matches.
- `audience-explain-exclusion` shows why another user does not match.

## How to get to it (user POV)

- Identify and track users through `/api/v1/identify` and `/api/v1/track` with the publishable key.
- Discover fields through `GET /api/v1/audiences/capabilities` with the secret key.
- Evaluate through `POST /api/v1/audiences/check` and `POST /api/v1/audiences/explain`.

## Driving it with control-galinum

Preconditions:

- A fresh run passes doctor.
- No users or events exist in the run.

- **Drive.** Run `fnm exec --using=24 -- node .agents/skills/verify-galinum/scripts/control-galinum.mjs scenario "$GALINUM_VERIFY_RUN_ID" audience-matching`.
- **Seed.** Steps 1-4 create `verify-free` and `verify-pro`. They track CSV and JSON export events through SDK routes.
- **Discover.** Step 5 reads capabilities. The observed trait list contains `plan`.
- **Check.** Step 6 evaluates `plan = free` and `exported.format = csv`. The response reports one match from two users and samples `verify-free`.
- **Explain inclusion.** Step 7 explains `verify-free`. The response returns `matched: true` with condition evidence.
- **Explain exclusion.** Step 8 explains `verify-pro`. The response returns `matched: false`.
- **Proof.** Require `audience-matching.http.txt` and `audience-matching.proof.json`. The proof names the included and excluded external user IDs.

## Gotchas

- Capabilities depend on observed data. Seed users and events before discovery.
- Event expressions default to at least one occurrence when count is omitted.
- Exact count proof needs both `matchedCount` and `totalUsers`.
- A sample is supporting evidence. It does not replace the exact count assertion.
