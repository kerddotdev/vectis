import { afterEach, expect, test, vi } from "vitest";
import {
  ScaleSetAdminClient,
  ScaleSetHttpError,
  ScaleSetProtocolError,
  ScaleSetSessionClient,
  decodeMessage,
  type Fetch,
  type Session,
} from "./index.js";

const serviceUrl = "https://actions.example.test/tenant/repository/";
const session: Session = {
  sessionId: "c6400b58-622b-497d-9c97-d706d852570a",
  ownerName: "machine-7",
  messageQueueUrl: "https://queue.example.test/messages?session=opaque",
  messageQueueAccessToken: "queue-secret",
  statistics: { totalAssignedJobs: 3 },
};
const available = { messageType: "JobAvailable", runnerRequestId: 501 };
function envelope(jobs: unknown = [available]) {
  return {
    messageId: 9,
    messageType: "RunnerScaleSetJobMessages",
    body: JSON.stringify(jobs),
    statistics: { totalAssignedJobs: 83, totalRunningJobs: 2 },
  };
}
function host(fetch: Fetch, grant = session) {
  return new ScaleSetSessionClient(serviceUrl, 17, grant, fetch);
}
afterEach(() => vi.useRealTimers());

test("admin session lifecycle preserves the tenant path and never uses the queue token", async () => {
  const fetch = vi.fn<Fetch>(async (_url, init) =>
    init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(session),
  );
  const cloud = new ScaleSetAdminClient(serviceUrl, "admin-secret", fetch);
  expect(await cloud.createSession(17, "machine-7")).toEqual(session);
  expect(await cloud.refreshSession(17, session.sessionId)).toEqual(session);
  await cloud.deleteSession(17, session.sessionId);
  expect(fetch.mock.calls.map(([url, init]) => [url.href, init.method])).toEqual([
    [`${serviceUrl}_apis/runtime/runnerscalesets/17/sessions?api-version=6.0-preview`, "POST"],
    [
      `${serviceUrl}_apis/runtime/runnerscalesets/17/sessions/${session.sessionId}?api-version=6.0-preview`,
      "PATCH",
    ],
    [
      `${serviceUrl}_apis/runtime/runnerscalesets/17/sessions/${session.sessionId}?api-version=6.0-preview`,
      "DELETE",
    ],
  ]);
  expect(fetch.mock.calls[0]?.[1].body).toBe(JSON.stringify({ ownerName: "machine-7" }));
  expect(fetch.mock.calls[1]?.[1].body).toBeUndefined();
  for (const [, init] of fetch.mock.calls) {
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer admin-secret");
    expect(init.redirect).toBe("error");
  }
});

test("host polls, acquires and acknowledges using only its queue credential", async () => {
  const fetch = vi.fn<Fetch>(async (_url, init) => {
    if (init.method === "GET") return Response.json(envelope());
    if (init.method === "POST") return Response.json({ count: 1, value: [501] });
    return new Response(null, { status: 204 });
  });
  const client = host(fetch);
  const message = await client.getMessage(8, 4);
  expect(message?.statistics.totalAssignedJobs).toBe(83);
  expect(message?.jobs).toEqual([available]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await client.acquireJobs([501, 502])).toEqual([501]);
  await client.acknowledgeMessage(9);
  expect(fetch.mock.calls.map(([url]) => url.href)).toEqual([
    "https://queue.example.test/messages?session=opaque&lastMessageId=8",
    `${serviceUrl}_apis/runtime/runnerscalesets/17/acquirejobs?api-version=6.0-preview`,
    "https://queue.example.test/messages/9?session=opaque",
  ]);
  const headers = new Headers(fetch.mock.calls[0]?.[1].headers);
  expect(headers.get("X-ScaleSetMaxCapacity")).toBe("4");
  expect(headers.get("Accept")).toBe("application/json; api-version=6.0-preview");
  expect(fetch.mock.calls[1]?.[1].body).toBe("[501,502]");
  for (const [, init] of fetch.mock.calls)
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer queue-secret");
});

test("202 means no new observation, permits zero capacity, and does not acknowledge", async () => {
  const fetch = vi.fn<Fetch>(async () => new Response(null, { status: 202 }));
  expect(await host(fetch).getMessage(0, 0)).toBeNull();
  expect(fetch.mock.calls[0]?.[0].searchParams.has("lastMessageId")).toBe(false);
  expect(new Headers(fetch.mock.calls[0]?.[1].headers).get("X-ScaleSetMaxCapacity")).toBe("0");
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("an unacknowledged message may be delivered twice without hidden acknowledgments", async () => {
  const fetch = vi.fn<Fetch>(async () => Response.json(envelope()));
  const client = host(fetch);
  expect(await client.getMessage(0, 1)).toEqual(await client.getMessage(0, 1));
  expect(fetch.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
});

test("an expired queue token requires an explicit cloud refresh, then polling uses the new grant", async () => {
  const fetch = vi.fn<Fetch>(async (_url, init) => {
    if (init.method === "PATCH")
      return Response.json({ ...session, messageQueueAccessToken: "renewed-secret" });
    return new Headers(init.headers).get("Authorization") === "Bearer renewed-secret"
      ? Response.json(envelope())
      : new Response("not logged", { status: 401 });
  });
  await expect(host(fetch).getMessage(0, 1)).rejects.toMatchObject({
    status: 401,
    queueTokenExpired: true,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  const cloud = new ScaleSetAdminClient(serviceUrl, "admin-secret", fetch);
  const refreshed = await cloud.refreshSession(17, session.sessionId);
  expect(await host(fetch, refreshed).getMessage(0, 1)).toMatchObject({ messageId: 9 });
  expect(fetch).toHaveBeenCalledTimes(3);
});

test.each(["acquire", "ack"])(
  "%s also reports an expired queue token without admin access",
  async (method) => {
    const fetch = vi.fn<Fetch>(async () => new Response(null, { status: 401 }));
    const client = host(fetch);
    await expect(
      method === "acquire" ? client.acquireJobs([501]) : client.acknowledgeMessage(9),
    ).rejects.toMatchObject({ queueTokenExpired: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test.each([403, 404, 409, 429, 500, 503])(
  "HTTP %i stays observable and is never blindly retried",
  async (status) => {
    const fetch = vi.fn<Fetch>(
      async () =>
        new Response("sensitive upstream body", { status, headers: { "Retry-After": "15" } }),
    );
    const cloud = new ScaleSetAdminClient(serviceUrl, "admin-secret", fetch);
    await expect(cloud.createSession(17, "machine-7")).rejects.toMatchObject({
      status,
      retryAfter: "15",
      queueTokenExpired: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test("errors omit endpoint tokens and response bodies", async () => {
  const error = new ScaleSetHttpError(401, null, true);
  expect(String(error)).toBe("ScaleSetHttpError: Scale set request failed (401).");
  const fetch: Fetch = async () => Response.json({ messageQueueAccessToken: "secret" });
  await expect(
    new ScaleSetAdminClient(serviceUrl, "admin", fetch).createSession(17, "host"),
  ).rejects.toThrow("Invalid or unsupported scale set response.");
});

test("caller cancellation aborts an outstanding long poll", async () => {
  const fetch = vi.fn<Fetch>(async (_url, init) => {
    const signal = init.signal;
    if (!signal) throw new Error("Expected signal");
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const abort = new AbortController();
  const result = host(fetch).getMessage(0, 1, abort.signal);
  const assertion = expect(result).rejects.toThrow("stop poll");
  abort.abort(new Error("stop poll"));
  await assertion;
  expect(fetch.mock.calls[0]?.[1].signal?.aborted).toBe(true);
});

test("an already aborted call sends no HTTP request", async () => {
  const fetch = vi.fn<Fetch>();
  const abort = new AbortController();
  abort.abort(new Error("already stopped"));
  await expect(host(fetch).getMessage(0, 1, abort.signal)).rejects.toThrow("already stopped");
  expect(fetch).not.toHaveBeenCalled();
});

test("the poll has a finite deadline even without caller cancellation", async () => {
  vi.useFakeTimers();
  const fetch: Fetch = async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  const assertion = expect(host(fetch).getMessage(0, 1)).rejects.toMatchObject({
    name: "TimeoutError",
  });
  await vi.advanceTimersByTimeAsync(70000);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

test("completed and failed requests release their deadline timers", async () => {
  vi.useFakeTimers();
  const fetch: Fetch = async () => new Response(null, { status: 202 });
  await host(fetch).getMessage(0, 1);
  expect(vi.getTimerCount()).toBe(0);
  const failure: Fetch = async () => new Response(null, { status: 503 });
  await expect(host(failure).getMessage(0, 1)).rejects.toMatchObject({ status: 503 });
  expect(vi.getTimerCount()).toBe(0);
});

test("cancellation while reading a response remains cancellation", async () => {
  const abort = new AbortController();
  const fetch: Fetch = async (_url, init) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
            once: true,
          });
        },
      }),
    );
  const result = host(fetch).getMessage(0, 1, abort.signal);
  const assertion = expect(result).rejects.toThrow("stop body");
  await Promise.resolve();
  abort.abort(new Error("stop body"));
  await assertion;
});

test("transport failure does not silently repeat an acquire with uncertain outcome", async () => {
  const fetch = vi.fn<Fetch>(async () => {
    throw new TypeError("connection lost");
  });
  await expect(host(fetch).acquireJobs([501])).rejects.toThrow("connection lost");
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("acquire accepts a partial or empty confirmed subset, including repeated calls", async () => {
  const fetch = vi
    .fn<Fetch>()
    .mockResolvedValueOnce(Response.json({ count: 1, value: [501] }))
    .mockResolvedValueOnce(Response.json({ count: 0, value: [] }));
  const client = host(fetch);
  expect(await client.acquireJobs([501, 502])).toEqual([501]);
  expect(await client.acquireJobs([501, 502])).toEqual([]);
});

test.each([
  { count: 1, value: [999] },
  { count: 0, value: [501] },
  { count: 2, value: [501, 501] },
  { count: 1, value: [Number.MAX_SAFE_INTEGER + 1] },
])("acquire rejects inconsistent confirmations: %j", async (response) => {
  const fetch: Fetch = async () => Response.json(response);
  await expect(host(fetch).acquireJobs([501])).rejects.toBeInstanceOf(ScaleSetProtocolError);
});

test("all four job messages decode without treating request IDs as REST job IDs", () => {
  const jobs = [
    available,
    { messageType: "JobAssigned", runnerRequestId: 502, jobId: "opaque-job-id" },
    { messageType: "JobStarted", runnerRequestId: 501, runnerId: 81, runnerName: "vm-81" },
    { messageType: "JobCompleted", runnerRequestId: 502, result: "canceled", runnerId: 0 },
  ];
  expect(decodeMessage(envelope(jobs)).jobs).toEqual(jobs);
  expect(decodeMessage({ ...envelope(), messageId: 0, body: "" }).jobs).toEqual([]);
});

test.each([
  { ...envelope(), messageType: "UnknownEnvelope" },
  { ...envelope(), body: "not json" },
  { ...envelope(), statistics: null },
  { ...envelope(), statistics: { totalAssignedJobs: -1 } },
  { ...envelope(), statistics: { totalAssignedJobs: Number.MAX_SAFE_INTEGER + 1 } },
  envelope([{ messageType: "JobStarted", runnerRequestId: 501 }]),
  envelope(Array.from({ length: 51 }, () => available)),
])("malformed or unsupported data is never acknowledged: %j", async (response) => {
  const fetch = vi.fn<Fetch>(async () => Response.json(response));
  await expect(host(fetch).getMessage(0, 1)).rejects.toBeInstanceOf(ScaleSetProtocolError);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("response retention is bounded and malformed JSON fails decoding", async () => {
  for (const body of ["{", "x".repeat(1024 * 1024 + 1)]) {
    const fetch: Fetch = async () => new Response(body);
    await expect(host(fetch).getMessage(0, 1)).rejects.toBeInstanceOf(ScaleSetProtocolError);
  }
});

test("unsafe endpoint URLs, IDs and capacities fail before HTTP", async () => {
  const fetch = vi.fn<Fetch>();
  for (const url of [
    "http://queue.example.test",
    "https://user:secret@queue.example.test",
    "https://queue.example.test/#fragment",
  ]) {
    expect(() => host(fetch, { ...session, messageQueueUrl: url })).toThrow();
  }
  const cloud = new ScaleSetAdminClient(serviceUrl, "admin", fetch);
  await expect(cloud.refreshSession(17, "..")).rejects.toThrow();
  await expect(cloud.createSession(0, "host")).rejects.toThrow();
  await expect(host(fetch).getMessage(0, -1)).rejects.toThrow();
  await expect(host(fetch).acquireJobs([Number.MAX_SAFE_INTEGER + 1])).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
