import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it } from "vitest";
import { GalinumProvider, useGalinum } from "../src/context.js";
import { fixture } from "./fixture.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("provider exposes immutable updates and fences hooks captured by a previous user", async () => {
  const f = await fixture();
  const client = f.create();
  let api!: ReturnType<typeof useGalinum>;
  function Consumer() { api = useGalinum(); return null; }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<GalinumProvider client={client}><Consumer /></GalinumProvider>);
    await client.start();
  });
  await act(async () => { await api.identify("A"); });
  const a = api;
  expect(a.snapshot.userId).toBe("A");
  await act(async () => { await api.reset(); await api.identify("B"); });
  expect(api.snapshot.userId).toBe("B");
  await expect(a.track("old_callback")).rejects.toMatchObject({ code: "superseded" });
  expect(f.adapter.requestPermission).not.toHaveBeenCalled();
  await act(async () => { renderer.unmount(); });
  client.dispose();
  await f.journalReleased();
  expect(f.removed.length).toBe(f.callbacks.length);
});

it("preserves saved consent with child identify effects before the provider start effect", async () => {
  const f = await fixture();
  const previous = f.create();
  await previous.identify("A");
  await previous.setConsent(true);
  const revision = (await f.inspect())[0].tokenRevision;
  previous.dispose();
  await f.journalReleased();
  const client = f.create();
  const order: string[] = [];
  const start = client.start;
  client.start = () => { order.push("start"); return start(); };
  let identified!: Promise<void>;
  function Child() {
    const api = useGalinum();
    useEffect(() => { order.push("identify"); identified = api.identify("A"); }, []);
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<GalinumProvider client={client}><Child /></GalinumProvider>); });
  await act(async () => { await identified; await client.start(); });
  expect(order.slice(0, 2)).toEqual(["identify", "start"]);
  expect((await f.inspect())[0]).toMatchObject({ userId: "A", consent: true, hasToken: true, tokenRevision: revision });
  await act(async () => { renderer.unmount(); });
});
