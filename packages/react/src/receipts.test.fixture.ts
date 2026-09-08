export function ackBody(url: RequestInfo | URL, init?: RequestInit) {
  const delivery = /\/deliveries\/(.+)\/event$/.exec(new URL(String(url)).pathname)?.[1];
  if (!delivery) return { ok: true };
  const body = JSON.parse(String(init?.body));
  return { userId: body.userId, deliveryId: decodeURIComponent(delivery), type: body.type, receiptId: body.feedbackId, acknowledgedAt: 1000 };
}
export function ackResponse(url: RequestInfo | URL, init?: RequestInit, status = 200) {
  return Response.json(status === 200 ? ackBody(url, init) : { error: "fixture rejection" }, { status });
}
