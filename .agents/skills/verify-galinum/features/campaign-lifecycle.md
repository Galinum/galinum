# Campaign lifecycle

Campaign lifecycle lets a customer's agent create a draft web campaign, supervise its current state, and apply human-safe launch, pause, and end controls.

## Sub-features

- `campaign-create` creates one draft with a toast message.
- `campaign-detail` reads the created campaign through its public ID.
- `campaign-launch` moves a draft or paused campaign to running.
- `campaign-filter` finds the campaign through the running status filter.
- `campaign-pause` stops new delivery without ending the campaign.
- `campaign-end` moves the campaign to its terminal state.

## How to get to it (user POV)

- Send management requests to `/api/v1/campaigns` with the project secret key.
- Send status actions to `/api/v1/campaigns/{id}/status`.
- Filter the campaign list with `/api/v1/campaigns?status=running`.

## Driving it with control-galinum

Preconditions:

- A fresh run passes doctor.
- The run has not driven another scenario.

- **Drive.** Run `fnm exec --using=24 -- node .agents/skills/verify-galinum/scripts/control-galinum.mjs scenario "$GALINUM_VERIFY_RUN_ID" campaign-lifecycle`.
- **Create.** Step 1 sends `POST /api/v1/campaigns` with a named toast message. Status `201` returns a campaign in `draft` state.
- **Read.** Step 2 sends `GET /api/v1/campaigns/{id}`. The response returns the same generated ID.
- **Launch and filter.** Steps 3-6 identify a recipient, launch the campaign, list `status=running`, and confirm one eligible message.
- **Pause and confirm.** Steps 7-10 pause the campaign, read its state, identify another recipient, and confirm that recipient gets no message.
- **Relaunch and confirm.** Steps 11-13 relaunch the campaign, read its state, and confirm delivery resumes for the second recipient.
- **End and confirm.** Steps 14 and 15 end the campaign, then read campaign detail. Both responses show `ended`.
- **Proof.** Require `campaign-lifecycle.http.txt` and `campaign-lifecycle.proof.json`. The proof lists every state plus paused and resumed delivery counts.

## Gotchas

- A campaign cannot leave `ended` state. Use a fresh run for another lifecycle.
- A write response alone does not prove persistence. Require a confirming public read.
- The status filter uses effective status. This scenario has no delivery window, so stored and effective states agree.
