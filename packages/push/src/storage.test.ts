import { expect, it } from "vitest";
import { MemoryPushRecords } from "./storage.js";
import type { DeviceTarget, SlotWork } from "./types.js";
it("pages indexed records with exact totals and excludes completed targets from due reads", async () => {
  const store = new MemoryPushRecords(); store.begin();
  for (let index = 0; index < 205; index++) {
    const id = String(index).padStart(4, "0");
    const target: DeviceTarget = { id, slotId: id, generation: 1, replacesTargetId: null, campaignId: "campaign", deliveryId: `delivery-${index}`, userId: `user-${index % 5}`, externalId: "user", installationId: id, bindingGeneration: 1, tokenRevision: 1, tokenScope: "scope", credentialId: "credential", credentialRevision: 1, campaignFingerprint: "fingerprint", content: { title: "Title", body: "Body", destination: { kind: "website", url: "https://example.com" } }, expiresAt: 10000, replacementKey: null, createdAt: 0, createdOrder: index, test: false };
    await store.insertPushRecord("target", target);
    await store.insertPushRecord("outcome", { id, slotId: id, submission: "confirmed", campaignId: "campaign", targetId: id, attemptId: id, observedAt: 1, result: { kind: "accepted", providerId: id } });
    const slot: SlotWork = { id, recipientId: id, campaignId: "campaign", userId: target.userId, installationId: id, targetId: id, generation: 1, revision: 1, sequence: 1, submissionsUsed: 1, submissionNotBefore: 0, repair: null, uncertain: false, authRefreshRevision: null, expiresAt: 10000, test: false, state: index === 204 ? { kind: "ready", at: 5 } : { kind: "accepted", acceptanceId: id } };
    await store.savePushControl("queue", slot);
  }
  store.commit();
  expect((await store.queryPushRecords("target", { campaignId: "campaign", offset: 200, limit: 100 })).map((row) => row.id)).toEqual(["0200", "0201", "0202", "0203", "0204"]);
  expect((await store.pushTotals("campaign"))).toMatchObject({ users: { targeted: 5, accepted: 5 }, devices: { targeted: 205, accepted: 205 }, records: { targets: 205, outcomes: 205 } });
  expect(await store.queryPushRecords("queue", { dueAt: 5, limit: 100 })).toMatchObject([{ id: "0204", campaignId: "campaign", targetId: "0204", state: { kind: "ready", at: 5 } }]);
  await expect(store.queryPushRecords("target", { limit: 101 })).rejects.toThrow("bounded");
  const original = await store.getPushRecord("target", "0000");
  store.begin(); await store.savePushControl("queue", { ...(await store.getPushRecord("queue", "0204"))!, state: { kind: "closed", reason: "test" } }); store.rollback();
  expect(await store.queryPushRecords("queue", { dueAt: 5, limit: 1 })).toHaveLength(1);
  expect(await store.getPushRecord("target", "0000")).toEqual(original);
});
