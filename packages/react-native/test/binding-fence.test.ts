import { expect, it } from "vitest";
import { deferred, fixture } from "./fixture.js";

async function delayedBinding(initialUser: string | null) {
  const f = await fixture();
  const release = deferred<void>();
  const held: { body: Record<string, unknown>; applied: Promise<number> }[] = [];
  let rejectFence = false;
  let loseFence = false;
  const transport: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (String(input).endsWith("/binding") && body?.userId === "A") {
      const applied = deferred<number>();
      held.push({ body, applied: applied.promise });
      await release.promise;
      const response = await f.transport(input, { ...init, signal: undefined });
      applied.resolve(response.status);
      return response;
    }
    if (rejectFence && String(input).endsWith("/binding")) return new Response("{}", { status: 503 });
    const response = await f.transport(input, init);
    if (loseFence && String(input).endsWith("/binding")) throw new Error("lost fence acknowledgement");
    return response;
  };
  const client = f.create({ fetch: transport, requestTimeoutMs: 25 });
  if (initialUser === null) await client.start();
  else await client.identify(initialUser);
  await expect(client.identify("A")).rejects.toMatchObject({ code: "transport_uncertain" });
  expect(held).toHaveLength(2);
  expect(held[0]!.body).toEqual(held[1]!.body);
  expect((await f.inspect())[0]).toMatchObject({ userId: initialUser, hasToken: false });
  return { ...f, client, held, transport, release, rejectFence: () => { rejectFence = true; }, allowFence: () => { rejectFence = false; loseFence = false; }, loseFence: () => { loseFence = true; } };
}

for (const initialUser of [null, "B"]) {
  it(`${initialUser === null ? "anonymous reset" : "B to A to B"} advances a revision before old binding PUTs reach the server`, async () => {
    const f = await delayedBinding(initialUser);
    const before = (await f.inspect())[0];
    try {
      if (initialUser === null) await f.client.reset();
      else await f.client.identify("B");
      const fenced = (await f.inspect())[0];
      f.release.resolve();
      expect(await Promise.all(f.held.map(request => request.applied))).toEqual([409, 409]);
      expect((await f.inspect())[0].userId).toBe(initialUser);
      expect(fenced.revision).toBeGreaterThan(before.revision);
      expect(fenced.bindingGeneration).toBe(before.bindingGeneration);
    } finally {
      f.release.resolve();
      await Promise.all(f.held.map(request => request.applied));
    }
  });

  it(`${initialUser === null ? "reset" : "superseding B"} retains its unacknowledged fence across restart`, async () => {
    const f = await delayedBinding(initialUser);
    f.rejectFence();
    try {
      const superseding = initialUser === null ? f.client.reset() : f.client.identify("B");
      await expect(superseding).rejects.toMatchObject({ code: "http_error", status: 503 });
      const saved = f.control.state()!;
      expect(saved.session.userId).toBe(initialUser);
      expect(saved.acknowledgedBindingRevision).not.toBe(saved.bindingRevision);
      f.client.dispose();
      await f.journalReleased();
      f.allowFence();
      const restarted = f.create({ fetch: f.transport });
      await restarted.start();
      const acknowledged = f.control.state()!;
      expect(acknowledged.acknowledgedBindingRevision).toBe(acknowledged.bindingRevision);
      f.release.resolve();
      expect(await Promise.all(f.held.map(request => request.applied))).toEqual([409, 409]);
      expect((await f.inspect())[0].userId).toBe(initialUser);
    } finally {
      f.release.resolve();
      await Promise.all(f.held.map(request => request.applied));
    }
  });
}


it("retains a fence after its mutation applied but both acknowledgement responses were lost", async () => {
  const f = await delayedBinding(null);
  f.loseFence();
  try {
    await expect(f.client.reset()).rejects.toMatchObject({ code: "transport_uncertain" });
    const saved = f.control.state()!;
    expect(saved.acknowledgedBindingRevision).not.toBe(saved.bindingRevision);
    expect((await f.inspect())[0].userId).toBeNull();
    f.client.dispose();
      await f.journalReleased();
    f.allowFence();
    const restarted = f.create({ fetch: f.transport });
    await restarted.start();
    const acknowledged = f.control.state()!;
    expect(acknowledged.acknowledgedBindingRevision).toBe(acknowledged.bindingRevision);
    f.release.resolve();
    expect(await Promise.all(f.held.map(request => request.applied))).toEqual([409, 409]);
    expect((await f.inspect())[0].userId).toBeNull();
  } finally {
    f.release.resolve();
    await Promise.all(f.held.map(request => request.applied));
  }
});

it("every reset acknowledges a new revision even without a user, token or pending write", async () => {
  const f = await fixture();
  const client = f.create();
  await client.start();
  let previous = (await f.inspect())[0];
  for (let count = 0; count < 2; count++) {
    await client.reset();
    const current = (await f.inspect())[0];
    expect(current).toMatchObject({ userId: null, hasToken: false, bindingGeneration: previous.bindingGeneration, tokenRevision: previous.tokenRevision });
    expect(current.revision).toBe(previous.revision + 1);
    previous = current;
  }
  for (const request of f.requests.filter(request => request.path.endsWith("/binding"))) {
    expect(Object.keys(request.body!).sort()).toEqual(["bindingGeneration", "requestId", "revision", "userId"]);
  }
});

it("missing binding intent counters fail before network work", async () => {
  const f = await fixture();
  const previous = f.create();
  await previous.identify("A");
  await previous.setConsent(true);
  const before = (await f.inspect())[0];
  previous.dispose();
  await f.journalReleased();
  const saved = f.control.state() as Record<string, unknown>;
  delete saved.bindingRevision;
  delete saved.acknowledgedBindingRevision;
  f.control.set(saved as never);
  const client = f.create();
  const requests = f.requests.length;
  await expect(client.start()).rejects.toMatchObject({ code: "invalid_storage" });
  expect(f.requests).toHaveLength(requests);
  expect(client.getSnapshot().installation).toBeNull();
  expect((await f.inspect())[0]).toEqual(before);
});
