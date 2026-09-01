# Web in-app delivery

Web in-app delivery lets a customer launch a goal-linked message, serve it to an identified user, record exposure, and observe conversion.

## Sub-features

- `delivery-goal` creates the target event used for conversion.
- `delivery-campaign` creates and launches a toast campaign linked to the goal.
- `delivery-eligibility` returns one eligible SDK message for the user.
- `delivery-impression` records that the message became visible.
- `delivery-conversion` converts the exposed delivery after the target event.
- `delivery-management-read` confirms campaign totals and delivery state.

## How to get to it (user POV)

- Create goals and campaigns through management routes with the secret key.
- Identify users, poll messages, and record feedback through SDK routes with the publishable key.
- Read campaign detail and deliveries through management routes.

## Driving it with control-galinum

Preconditions:

- A fresh run passes doctor.
- No user, goal, campaign, or delivery exists in the run.

- **Drive.** Run `fnm exec --using=24 -- node .agents/skills/verify-galinum/scripts/control-galinum.mjs scenario "$GALINUM_VERIFY_RUN_ID" web-inapp-delivery`.
- **Create.** Steps 1 and 2 create an `activated` goal and launch a linked toast campaign.
- **Identify and poll.** Steps 3 and 4 identify `verify-recipient` and request messages. One message returns with the created campaign ID and a delivery ID.
- **Expose.** Step 5 sends a `shown` event for that delivery. Status `200` accepts the visible impression.
- **Convert.** Step 6 tracks `activated` for the same user through the SDK route.
- **Confirm totals.** Step 7 reads campaign detail. `stats.converted` equals one.
- **Confirm side effect.** Step 8 lists converted deliveries. It returns the same delivery ID and total one.
- **Proof.** Require `web-inapp-delivery.http.txt` and `web-inapp-delivery.proof.json`. The proof keeps goal, campaign, and delivery IDs.

## Gotchas

- Polling creates or returns the delivery. It does not prove that the message became visible.
- Record `shown` before the target event. Conversion requires an exposed delivery.
- Use the publishable key for identify, messages, delivery feedback, and track.
- Confirm conversion from both campaign totals and the delivery feed.
