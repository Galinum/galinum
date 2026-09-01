import { describe, expect, it } from "vitest";
import { readBody } from "./request-body.js";

describe("bounded request bodies", () => {
  it("stops reading the source stream as soon as the limit is crossed", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(16));
      },
    });
    const request = new Request("http://local", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(await readBody(request, 8)).toEqual({ ok: false, status: 413 });
    await Promise.resolve();
    expect(pulls).toBeLessThanOrEqual(2);
  });
});
