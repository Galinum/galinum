import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createLocalProduct } from "./local-product.js";

const freeOrPro = {
  version: 1,
  root: {
    kind: "field",
    field: { kind: "trait", key: "plan" },
    op: "in",
    value: ["pro", "free", "pro"],
  },
};

const enterprise = {
  version: 1,
  root: {
    kind: "field",
    field: { kind: "trait", key: "plan" },
    op: "eq",
    value: "enterprise",
  },
};

describe("immutable segment operations", () => {
  it("creates, replays, lists, and reads canonical segment versions", async () => {
    const clock = 1_755_000_000_000;
    const product = createLocalProduct({ now: () => clock });
    const app = createApp(product.handlers);
    const headers = { authorization: `Bearer ${product.secretKey}`, "content-type": "application/json" };
    const call = (path: string, method = "GET", value?: unknown) => app(new Request(`http://local${path}`, {
      method,
      headers,
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }));

    const createdResponse = await call("/api/v1/segments", "POST", {
      key: "paid-users",
      name: "Paid users",
      description: "Users on a paid plan",
      expression: freeOrPro,
      reason: "Initial audience",
      idempotencyKey: "segment-create-1",
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()).segment;
    expect(created).toMatchObject({
      key: "paid-users",
      name: "Paid users",
      description: "Users on a paid plan",
      status: "active",
      currentVersion: 1,
      schemaVersion: 1,
      reason: "Initial audience",
      createdBy: "api",
      createdAt: clock,
      updatedAt: clock,
      expression: { root: { value: ["free", "pro"] } },
    });
    expect(created.id).toMatch(/^seg_/);
    expect(created.currentAudienceVersionId).toMatch(/^aud_/);
    expect(created.expressionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.summary).toContain("trait plan is one of");

    const replayResponse = await call("/api/v1/segments", "POST", {
      key: "ignored-key",
      name: "Ignored name",
      expression: enterprise,
      idempotencyKey: "segment-create-1",
    });
    expect(replayResponse.status).toBe(200);
    expect((await replayResponse.json()).segment).toMatchObject({
      id: created.id,
      key: "paid-users",
      name: "Paid users",
      expressionHash: created.expressionHash,
    });

    expect((await call("/api/v1/segments", "POST", {
      key: "paid-users",
      name: "Duplicate",
      expression: enterprise,
    })).status).toBe(409);
    expect(await (await call("/api/v1/segments?status=active")).json()).toMatchObject({
      segments: [{ id: created.id, key: "paid-users", currentVersion: 1 }],
    });
    expect((await (await call("/api/v1/segments/paid-users")).json()).segment.expressionHash).toBe(created.expressionHash);
    const checked = await (await call("/api/v1/audiences/check", "POST", { segment: "paid-users", sampleLimit: 0 })).json();
    expect(checked).toMatchObject({ matchedCount: 0, segment: { id: created.id, key: "paid-users", version: 1 } });
    expect((await call("/api/v1/segments?status=invalid")).status).toBe(400);
  });

  it("keeps versions immutable and enforces revision concurrency and archive rules", async () => {
    let clock = 1_755_000_000_000;
    const product = createLocalProduct({ now: () => clock });
    const app = createApp(product.handlers);
    const headers = { authorization: `Bearer ${product.secretKey}`, "content-type": "application/json" };
    const call = (path: string, method = "GET", value?: unknown) => app(new Request(`http://local${path}`, {
      method,
      headers,
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }));
    const created = (await (await call("/api/v1/segments", "POST", {
      key: "enterprise-users",
      name: "Enterprise users",
      expression: freeOrPro,
    })).json()).segment;

    clock += 1;
    const metadataResponse = await call(`/api/v1/segments/${created.id}`, "PATCH", {
      name: "Qualified users",
      description: "Current qualification",
    });
    expect(await metadataResponse.json()).toMatchObject({
      segment: { name: "Qualified users", currentVersion: 1, updatedAt: clock },
    });

    clock += 1;
    const revisionResponse = await call(`/api/v1/segments/${created.id}`, "PATCH", {
      expression: enterprise,
      expectedVersion: 1,
      reason: "Narrow to enterprise",
    });
    expect(revisionResponse.status).toBe(200);
    const revised = (await revisionResponse.json()).segment;
    expect(revised).toMatchObject({ currentVersion: 2, reason: "Narrow to enterprise", expression: enterprise });
    expect(revised.currentAudienceVersionId).not.toBe(created.currentAudienceVersionId);

    const staleResponse = await call(`/api/v1/segments/${created.id}`, "PATCH", {
      name: "Must not apply",
      expression: freeOrPro,
      expectedVersion: 1,
    });
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toEqual({ error: "Stale expectedVersion", currentVersion: 2 });
    expect((await (await call(`/api/v1/segments/${created.id}`)).json()).segment.name).toBe("Qualified users");

    const versions = await (await call(`/api/v1/segments/${created.id}/versions`)).json();
    expect(versions).toMatchObject({
      segmentId: created.id,
      versions: [
        { version: 2, reason: "Narrow to enterprise" },
        { version: 1, reason: null },
      ],
    });
    const firstVersion = await (await call(`/api/v1/segments/${created.id}/versions/1`)).json();
    expect(firstVersion).toMatchObject({
      segmentId: created.id,
      version: { version: 1, expression: { root: { value: ["free", "pro"] } } },
    });

    clock += 1;
    const archivedResponse = await call(`/api/v1/segments/${created.id}/archive`, "POST");
    expect(archivedResponse.status).toBe(200);
    expect(await archivedResponse.json()).toMatchObject({ segment: { status: "archived", currentVersion: 2 } });
    expect((await call(`/api/v1/segments/${created.id}/archive`, "POST")).status).toBe(409);
    expect((await call(`/api/v1/segments/${created.id}`, "PATCH", {
      expression: freeOrPro,
      expectedVersion: 2,
    })).status).toBe(409);

    clock += 1;
    const archivedMetadata = await call(`/api/v1/segments/${created.id}`, "PATCH", { name: "Archived enterprise users" });
    expect(archivedMetadata.status).toBe(200);
    expect(await archivedMetadata.json()).toMatchObject({
      segment: { name: "Archived enterprise users", status: "archived", currentVersion: 2 },
    });
    expect((await (await call("/api/v1/segments?status=archived")).json()).segments).toHaveLength(1);
  });
});
