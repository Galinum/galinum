import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createLocalProduct } from "./local-product.js";

const expression = {
  version: 1,
  root: {
    kind: "all",
    children: [
      { kind: "field", field: { kind: "trait", key: "plan" }, op: "eq", value: "free" },
      {
        kind: "event",
        event: "exported",
        where: [
          { kind: "field", field: { kind: "event_property", key: "format" }, op: "eq", value: "csv" },
        ],
      },
      {
        kind: "field",
        field: { kind: "user", field: "lastSeenAt" },
        op: "within_last",
        value: { amount: 1, unit: "days" },
      },
    ],
  },
};

describe("audience management operations", () => {
  it("discovers observed vocabulary and checks a canonical expression", async () => {
    let clock = 1_755_000_000_000;
    const product = createLocalProduct({ now: () => clock });
    const app = createApp(product.handlers);
    const secret = { authorization: `Bearer ${product.secretKey}`, "content-type": "application/json" };
    const publishable = { authorization: `Bearer ${product.publishableKey}`, "content-type": "application/json" };
    const call = (path: string, method = "GET", value?: unknown, headers = secret) => app(new Request(`http://local${path}`, {
      method,
      headers,
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }));

    await call("/api/v1/identify", "POST", { userId: "user_free", traits: { plan: "free", seats: 4 } }, publishable);
    await call("/api/v1/identify", "POST", { userId: "user_pro", traits: { plan: "pro", seats: 12 } }, publishable);
    clock += 1_000;
    await call("/api/v1/track", "POST", { userId: "user_free", event: "exported", props: { format: "csv", rows: 10 } }, publishable);
    await call("/api/v1/track", "POST", { userId: "user_pro", event: "exported", props: { format: "json", rows: 20 } }, publishable);

    const capabilitiesResponse = await call("/api/v1/audiences/capabilities");
    expect(capabilitiesResponse.status).toBe(200);
    const capabilities = (await capabilitiesResponse.json()).capabilities;
    expect(capabilities.expression).toMatchObject({
      versions: [1],
      nodeKinds: ["all", "any", "not", "field", "event"],
      windowUnits: ["minutes", "hours", "days"],
      limits: { maxDepth: 8, maxEvaluatedEventOccurrences: 10_001 },
    });
    expect(capabilities.lifecycleFields).toEqual([
      { field: "firstSeenAt", type: "datetime" },
      { field: "lastSeenAt", type: "datetime" },
    ]);
    expect(capabilities.traits).toContainEqual({
      key: "plan",
      types: { string: 2 },
      users: 2,
      values: ["free", "pro"],
    });
    expect(capabilities.events).toContainEqual(expect.objectContaining({
      name: "exported",
      users: 2,
      occurrences: 2,
      properties: expect.arrayContaining([
        { key: "format", types: { string: 2 } },
        { key: "rows", types: { number: 2 } },
      ]),
    }));

    const checkResponse = await call("/api/v1/audiences/check", "POST", { expression, sampleLimit: 1 });
    expect(checkResponse.status).toBe(200);
    const checked = await checkResponse.json();
    expect(checked).toMatchObject({
      evaluatedAt: clock,
      countType: "exact",
      matchedCount: 1,
      totalUsers: 2,
      diagnostics: [],
      samples: [{
        externalUserId: "user_free",
        traits: { plan: "free" },
        events: { exported: 1 },
      }],
    });
    expect(checked.expression.root.children[1].count).toEqual({ op: "gte", value: 1 });
    expect(checked.expressionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(checked.summary).toContain("trait plan is \"free\"");
  });

  it("returns validation and observed-vocabulary diagnostics", async () => {
    const product = createLocalProduct();
    const app = createApp(product.handlers);
    const secret = { authorization: `Bearer ${product.secretKey}`, "content-type": "application/json" };
    const publishable = { authorization: `Bearer ${product.publishableKey}`, "content-type": "application/json" };
    await app(new Request("http://local/api/v1/identify", {
      method: "POST",
      headers: publishable,
      body: JSON.stringify({ userId: "user_1", traits: { plan: "free" } }),
    }));

    const invalid = await app(new Request("http://local/api/v1/audiences/check", {
      method: "POST",
      headers: secret,
      body: JSON.stringify({ expression: { version: 1, root: { kind: "all", children: [] } } }),
    }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ diagnostics: [{ code: "empty_group", path: "/root/children" }] });

    const typo = await app(new Request("http://local/api/v1/audiences/check", {
      method: "POST",
      headers: secret,
      body: JSON.stringify({
        expression: {
          version: 1,
          root: { kind: "field", field: { kind: "trait", key: "plam" }, op: "eq", value: "free" },
        },
        sampleLimit: 0,
      }),
    }));
    expect(typo.status).toBe(200);
    expect((await typo.json()).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unobserved_trait", path: "/root" }),
      expect.objectContaining({ code: "zero_matches", path: "/root" }),
    ]));
  });

  it("explains one user with the core evidence trace", async () => {
    const clock = 1_755_000_000_000;
    const product = createLocalProduct({ now: () => clock });
    const app = createApp(product.handlers);
    const secret = { authorization: `Bearer ${product.secretKey}`, "content-type": "application/json" };
    const publishable = { authorization: `Bearer ${product.publishableKey}`, "content-type": "application/json" };
    await app(new Request("http://local/api/v1/identify", {
      method: "POST",
      headers: publishable,
      body: JSON.stringify({ userId: "user_free", traits: { plan: "free" } }),
    }));
    await app(new Request("http://local/api/v1/track", {
      method: "POST",
      headers: publishable,
      body: JSON.stringify({ userId: "user_free", event: "exported", props: { format: "csv" } }),
    }));

    const response = await app(new Request("http://local/api/v1/audiences/explain", {
      method: "POST",
      headers: secret,
      body: JSON.stringify({ expression, userId: "user_free" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { externalUserId: "user_free", firstSeenAt: clock, lastSeenAt: clock },
      matched: true,
      evaluatedAt: clock,
      trace: {
        path: "/root",
        kind: "all",
        matched: true,
        children: [
          { path: "/root/children/0", kind: "field", matched: true, observed: "free", observedType: "string" },
          { path: "/root/children/1", kind: "event", matched: true, event: "exported", occurrences: 1 },
          { path: "/root/children/2", kind: "field", matched: true, observed: clock, observedType: "number" },
        ],
      },
    });
  });

  it("scans beyond 200 users in exact bounded batches", async () => {
    const product = createLocalProduct({
      audienceUserBatchSize: 25,
      sdkRateLimit: { perMinute: 1_000, perHour: 1_000 },
      managementRateLimit: { perMinute: 1_000, perHour: 1_000 },
    });
    const app = createApp(product.handlers);
    const secret = { authorization: `Bearer ${product.secretKey}`, "content-type": "application/json" };
    const publishable = { authorization: `Bearer ${product.publishableKey}`, "content-type": "application/json" };
    for (let index = 0; index < 201; index += 1) {
      await app(new Request("http://local/api/v1/identify", {
        method: "POST", headers: publishable,
        body: JSON.stringify({ userId: `user_${index}`, traits: { plan: index % 2 === 0 ? "free" : "pro" } }),
      }));
    }
    const response = await app(new Request("http://local/api/v1/audiences/check", {
      method: "POST", headers: secret,
      body: JSON.stringify({ expression: { version: 1, root: { kind: "field", field: { kind: "trait", key: "plan" }, op: "eq", value: "free" } } }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ totalUsers: 201, matchedCount: 101, countType: "exact" });
  });

  it("keeps event-name partitions exact and fails one-user overflow closed", async () => {
    let clock = 1_755_000_000_000;
    const product = createLocalProduct({ now: () => clock, audienceEventRowBudget: 2 });
    const app = createApp(product.handlers);
    const secret = { authorization: `Bearer ${product.secretKey}`, "content-type": "application/json" };
    const publishable = { authorization: `Bearer ${product.publishableKey}`, "content-type": "application/json" };
    const call = (path: string, method: string, value: unknown, headers = publishable) => app(new Request(`http://local${path}`, { method, headers, body: JSON.stringify(value) }));
    await call("/api/v1/identify", "POST", { userId: "events" });
    await call("/api/v1/track", "POST", { userId: "events", event: "acted", props: { format: "csv" } });
    await call("/api/v1/track", "POST", { userId: "events", event: "acted", props: { format: "json" } });
    clock += 10_000;
    for (let index = 0; index < 5; index += 1) await call("/api/v1/track", "POST", { userId: "events", event: "acted", props: { format: "future" } });
    clock -= 10_000;
    const repeated = {
      version: 1,
      root: { kind: "all", children: [
        { kind: "event", event: "acted", where: [{ kind: "field", field: { kind: "event_property", key: "format" }, op: "eq", value: "csv" }] },
        { kind: "event", event: "acted", where: [{ kind: "field", field: { kind: "event_property", key: "format" }, op: "eq", value: "json" }] },
      ] },
    };
    expect(await (await call("/api/v1/audiences/check", "POST", { expression: repeated }, secret)).json()).toMatchObject({ matchedCount: 1 });

    const constrained = createLocalProduct({ now: () => clock, audienceEventRowBudget: 1 });
    const constrainedApp = createApp(constrained.handlers);
    const constrainedSecret = { authorization: `Bearer ${constrained.secretKey}`, "content-type": "application/json" };
    const constrainedPub = { authorization: `Bearer ${constrained.publishableKey}`, "content-type": "application/json" };
    for (const event of ["one", "two"]) await constrainedApp(new Request("http://local/api/v1/track", { method: "POST", headers: constrainedPub, body: JSON.stringify({ userId: "overflow", event }) }));
    const capacity = await constrainedApp(new Request("http://local/api/v1/audiences/check", {
      method: "POST", headers: constrainedSecret,
      body: JSON.stringify({ expression: { version: 1, root: { kind: "all", children: [{ kind: "event", event: "one" }, { kind: "event", event: "two" }] } } }),
    }));
    expect(capacity.status).toBe(503);
  });

  it("holds one exact memory snapshot across concurrent identify and track", async () => {
    const product = createLocalProduct({ audienceUserBatchSize: 1 });
    const app = createApp(product.handlers);
    const secret = { authorization: `Bearer ${product.secretKey}`, "content-type": "application/json" };
    const publishable = { authorization: `Bearer ${product.publishableKey}`, "content-type": "application/json" };
    await app(new Request("http://local/api/v1/identify", { method: "POST", headers: publishable, body: JSON.stringify({ userId: "first", traits: { plan: "free" } }) }));
    const check = app(new Request("http://local/api/v1/audiences/check", {
      method: "POST", headers: secret,
      body: JSON.stringify({ expression: { version: 1, root: { kind: "field", field: { kind: "trait", key: "plan" }, op: "eq", value: "free" } } }),
    }));
    await Promise.resolve();
    const identify = app(new Request("http://local/api/v1/identify", { method: "POST", headers: publishable, body: JSON.stringify({ userId: "second", traits: { plan: "free" } }) }));
    const track = app(new Request("http://local/api/v1/track", { method: "POST", headers: publishable, body: JSON.stringify({ userId: "first", event: "late" }) }));
    expect(await (await check).json()).toMatchObject({ totalUsers: 1, matchedCount: 1 });
    await Promise.all([identify, track]);
  });

  it("preserves capability aggregates and truncation flags", async () => {
    const product = createLocalProduct({ sdkRateLimit: { perMinute: 1_000, perHour: 1_000 } });
    const app = createApp(product.handlers);
    const secret = { authorization: `Bearer ${product.secretKey}` };
    const publishable = { authorization: `Bearer ${product.publishableKey}`, "content-type": "application/json" };
    const traits = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`trait_${index}`, `value_${index}`]));
    await app(new Request("http://local/api/v1/identify", { method: "POST", headers: publishable, body: JSON.stringify({ userId: "capabilities", traits }) }));
    for (let index = 0; index < 101; index += 1) {
      await app(new Request("http://local/api/v1/track", { method: "POST", headers: publishable, body: JSON.stringify({ userId: "capabilities", event: `event_${index}`, props: { source: "test" } }) }));
    }
    const capabilities = (await (await app(new Request("http://local/api/v1/audiences/capabilities", { headers: secret }))).json()).capabilities;
    expect(capabilities).toMatchObject({ traitsTruncated: true, eventsTruncated: true });
    expect(capabilities.traits).toHaveLength(100);
    expect(capabilities.events).toHaveLength(100);
    expect(capabilities.events[0]).toMatchObject({ users: 1, occurrences: 1, properties: [{ key: "source", types: { string: 1 } }] });
  });
});
