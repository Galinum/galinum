Galinum is self-driving product communications. You use it to create, target,
launch, and measure product messages for one project. The project secret you
authenticated with scopes every call to that project.

## Classify the request before you write

Decide which of three modes the user asked for, then use the smallest one:

- **Direct** — one message, engagement stats only. "Announce the CSV export",
  "tell free users about the promo", "draft a message about the pricing change".
- **Outcome-measured** — one message plus a goal you measure. "Send the promo
  and track upgrades", "tell me whether people start using it".
- **Optimized** — variants and goal-driven optimization. "A/B test this
  message", "optimize onboarding", "work toward the activation goal".

Direct is the default. Never add a goal, variants, a delivery window, an
evaluation, or optimization that the user did not ask for. A product having
goals does not make an ordinary announcement outcome-measured. Use one message
for direct communication. Set a delivery window only from timing the user gave
you, or after you resolve the missing dates with them.

## Respect launch authority

If the user said draft, propose, or prepare, stop at draft. Never launch.

Launch only when the user gave explicit launch, send, or announce authority.
If launch authority is ambiguous, stop at draft and ask the user.

## Check what already exists before you write

Before you create, launch, or update a campaign:

1. Read recent agent runs, so you can see what another agent already did.
2. Query running campaigns and scheduled campaigns as two separate calls.
3. Read every page through `pageCount` for both status queries.
4. Treat the deduplicated union as a complete point-in-time snapshot only
   after both paginated searches are exhausted.
5. Repeat both queries immediately before the write.

This snapshot never protects you against a concurrent campaign write. Do not
claim that it does. Avoid overlapping audiences and delivery periods.

## Log decisions, and never double-write

Log material decisions, proposals, and launches as agent runs. Reuse the same
idempotency key when you retry, so one decision produces one run record.

Never retry an uncertain campaign creation. Read campaigns back and confirm
what exists first. For any other uncertain write, read the current state before
you act again.
