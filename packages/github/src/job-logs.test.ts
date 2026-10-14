import { afterEach, expect, test, vi } from "vitest";
import { GitHubAppClient } from "./app-client.js";
import { jobLogWindowBytes, jobLogChunkBytes, pageJobLog } from "./job-logs.js";

const client = new GitHubAppClient({ appId: 1, clientId: "test", privateKey: "unused" });
const path = "/repos/owner/repo/actions/jobs/4/logs";
const location = "https://productionresultssa0.blob.core.windows.net/logs/job?signed=test";
afterEach(() => vi.unstubAllGlobals());

function logsFetch(bytes: Uint8Array, ranges = true) {
  let transferred = 0;
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (String(url).startsWith("https://api.github.com/")) {
      expect(headers.get("Authorization")).toBe("Bearer test-secret");
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { Location: location } });
    }
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.get("Accept-Encoding")).toBe("identity");
    expect(init?.redirect).toBe("error");
    const range = headers.get("Range") ?? "";
    if (!ranges) {
      transferred += bytes.length;
      return new Response(bytes.slice());
    }
    const start = range.startsWith("bytes=-")
      ? Math.max(0, bytes.length - Number(range.slice(7)))
      : Number(range.slice(6).split("-")[0]);
    const requestedEnd = range.startsWith("bytes=-") ? "" : range.slice(6).split("-")[1];
    const end = requestedEnd ? Math.min(Number(requestedEnd), bytes.length - 1) : bytes.length - 1;
    if (start >= bytes.length)
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${bytes.length}` },
      });
    transferred += end - start + 1;
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${end}/${bytes.length}` },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return Object.assign(fetch, { transferredBytes: () => transferred });
}

test.each([
  "https://evil.example/logs",
  "https://actions.githubusercontent.com.evil.example/logs",
  "https://account.blob.core.windows.net.evil.example/logs",
  "http://productionresultssa0.blob.core.windows.net/logs",
  "https://user:password@results-receiver.actions.githubusercontent.com/logs",
  "https://results-receiver.actions.githubusercontent.com:8443/logs",
  "https://account.sub.blob.core.windows.net/logs",
  null,
])("rejects an untrusted redirect without forwarding credentials: %s", async (location) => {
  const fetch = vi.fn(
    async () =>
      new Response(null, { status: 302, headers: location ? { Location: location } : {} }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(client.downloadJobLog("test-secret", path)).rejects.toThrow("log download URL");
  expect(fetch).toHaveBeenCalledOnce();
});

test.each([200, 301, 403, 404, 500])(
  "non-302 log responses retain status %s and omit response secrets",
  async (status) => {
    vi.stubGlobal("fetch", async () => new Response("private-url-or-secret", { status }));
    await expect(client.downloadJobLog("test-secret", path)).rejects.toMatchObject({
      status,
      message: `GitHub API request failed (${status}).`,
    });
  },
);

test("downloads a signed blob without authorization, requests a range and handles EOF", async () => {
  const bytes = new TextEncoder().encode("masked *** log\n");
  const fetch = logsFetch(bytes);
  const log = await client.downloadJobLog("test-secret", path, 3);
  expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("Range")).toBe(
    `bytes=3-${3 + jobLogChunkBytes + 3}`,
  );
  expect(log).toMatchObject({ start: 3, total: bytes.length });
  expect(pageJobLog(log, "completed", 3)).toMatchObject({
    text: "ked *** log\n",
    next: bytes.length,
    complete: true,
    truncated: false,
  });
  const eof = await client.downloadJobLog("test-secret", path, bytes.length);
  expect(pageJobLog(eof, "completed", bytes.length)).toMatchObject({
    text: "",
    next: bytes.length,
    complete: true,
  });
  await expect(client.downloadJobLog("test-secret", path, bytes.length + 1)).rejects.toThrow(
    "cursor exceeds",
  );
});

test("pages concatenate to the UTF-8 retained tail when a blob ignores Range", async () => {
  const source = "a".repeat(17) + "sample \u{1f6e0}\u00e9\n".repeat(450000);
  const bytes = new TextEncoder().encode(source);
  const fetch = logsFetch(bytes, false);
  const log = await client.downloadJobLog("test-secret", path);
  expect(log.bytes.length).toBe(jobLogWindowBytes);
  let after: number | undefined;
  let text = "";
  let pages = 0;
  while (true) {
    const chunk = pageJobLog(log, "completed", after);
    expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(jobLogChunkBytes);
    expect(Buffer.byteLength(JSON.stringify({ ok: true, result: chunk }))).toBeLessThan(262144);
    expect(chunk.text).not.toContain("\ufffd");
    expect(chunk.truncated).toBe(after === undefined);
    expect(chunk.next).toBeGreaterThan(after ?? log.start);
    after = chunk.next;
    text += chunk.text;
    pages++;
    if (chunk.complete) break;
  }
  let start = log.start;
  while (((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  expect(text).toBe(new TextDecoder().decode(bytes.subarray(start)));
  expect(after).toBe(bytes.length);
  expect(pages).toBeGreaterThan(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  const continued = await client.downloadJobLog("test-secret", path, log.start - 1);
  expect(pageJobLog(continued, "in_progress", log.start - 1).truncated).toBe(true);
});

test("completed is false before EOF or while the job is running, including an incomplete character", () => {
  const bytes = Buffer.from("\u00e9".repeat(jobLogChunkBytes));
  const log = { bytes, start: 0, total: bytes.length };
  const first = pageJobLog(log, "completed");
  expect(first.complete).toBe(false);
  const last = pageJobLog(log, "in_progress", first.next);
  expect(last.next).toBe(bytes.length);
  expect(last.complete).toBe(false);
  expect(pageJobLog(log, "completed", first.next).complete).toBe(true);
  const partial = { bytes: Buffer.from([0x61, 0xf0, 0x9f]), start: 0, total: 3 };
  expect(pageJobLog(partial, "in_progress")).toMatchObject({ text: "a", next: 1, complete: false });
  expect(() => pageJobLog(partial, "completed")).toThrow("incomplete UTF-8");
});

test("worst-case JSON escaping stays below the inspection cap", () => {
  const bytes = Buffer.alloc(jobLogChunkBytes * 2, 0);
  const chunk = pageJobLog({ bytes, start: 0, total: bytes.length }, "completed");
  expect(Buffer.byteLength(JSON.stringify({ ok: true, result: chunk }))).toBeLessThan(262144);
  expect(chunk.text).toHaveLength(jobLogChunkBytes);
});

test("the download cap cancels the stream and memory remains a bounded tail", async () => {
  const cancel = vi.fn();
  vi.stubGlobal("fetch", async (url: string | URL) => {
    if (String(url).startsWith("https://api.github.com/"))
      return new Response(null, { status: 302, headers: { Location: location } });
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(jobLogWindowBytes));
        },
        cancel,
      }),
    );
  });
  await expect(client.downloadJobLog("test-secret", path)).rejects.toThrow("exceeded 64 MiB");
  expect(cancel).toHaveBeenCalledOnce();
});

test("empty logs and malformed or incomplete ranges are handled without fabricated completion", async () => {
  logsFetch(new Uint8Array());
  expect(
    pageJobLog(await client.downloadJobLog("test-secret", path, 0), "completed", 0),
  ).toMatchObject({ text: "", next: 0, complete: true });
  for (const range of [
    "bytes 0-9/*",
    "bytes 0-4/10",
    "bytes 0-9/10",
    "bytes 1-9/10",
    "bytes 0-32772/100000",
    "bytes 0-9/9007199254740992",
  ]) {
    vi.stubGlobal("fetch", async (url: string | URL) =>
      String(url).startsWith("https://api.github.com/")
        ? new Response(null, { status: 302, headers: { Location: location } })
        : new Response("abc", { status: 206, headers: { "Content-Range": range } }),
    );
    await expect(client.downloadJobLog("test-secret", path)).rejects.toThrow("log byte range");
  }
});

test("UTF-8 byte order marks within the log are preserved across pages", () => {
  const bytes = Buffer.from("\uFEFF" + "x".repeat(jobLogChunkBytes - 3) + "\uFEFFtail");
  const log = { bytes, start: 0, total: bytes.length };
  const first = pageJobLog(log, "completed");
  const second = pageJobLog(log, "completed", first.next);
  expect(first.text + second.text).toBe(bytes.toString("utf8"));
});

test("retains the correct tail across fragmented stream chunks and a ring wrap", async () => {
  const source = Buffer.from("abcdefghij".repeat(500000));
  vi.stubGlobal("fetch", async (url: string | URL) => {
    if (String(url).startsWith("https://api.github.com/"))
      return new Response(null, { status: 302, headers: { Location: location } });
    let offset = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= source.length) controller.close();
          else {
            controller.enqueue(source.subarray(offset, offset + 123456));
            offset += 123456;
          }
        },
      }),
    );
  });
  const log = await client.downloadJobLog("test-secret", path);
  expect(log.start).toBe(source.length - jobLogWindowBytes);
  expect(log.bytes.equals(source.subarray(log.start))).toBe(true);
});

test("rejects encoded log bodies so range offsets cannot refer to compressed bytes", async () => {
  vi.stubGlobal("fetch", async (url: string | URL) =>
    String(url).startsWith("https://api.github.com/")
      ? new Response(null, { status: 302, headers: { Location: location } })
      : new Response("encoded", { headers: { "Content-Encoding": "gzip" } }),
  );
  await expect(client.downloadJobLog("test-secret", path)).rejects.toThrow("identity encoding");
});

test("an old cursor skips directly to the retained range even when the full log exceeds the download cap", async () => {
  const total = 128 * 1024 * 1024;
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).startsWith("https://api.github.com/"))
      return new Response(null, { status: 302, headers: { Location: location } });
    const range = new Headers(init?.headers).get("Range");
    if (range === `bytes=0-${jobLogChunkBytes + 3}`)
      return new Response(new Uint8Array(jobLogChunkBytes + 4), {
        status: 206,
        headers: { "Content-Range": `bytes 0-${jobLogChunkBytes + 3}/${total}` },
      });
    expect(range).toBe(
      `bytes=${total - jobLogWindowBytes}-${total - jobLogWindowBytes + jobLogChunkBytes + 3}`,
    );
    return new Response(new Uint8Array(jobLogChunkBytes + 4).fill(97), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${total - jobLogWindowBytes}-${total - jobLogWindowBytes + jobLogChunkBytes + 3}/${total}`,
      },
    });
  });
  vi.stubGlobal("fetch", fetch);
  const log = await client.downloadJobLog("test-secret", path, 0);
  expect(log.start).toBe(total - jobLogWindowBytes);
  expect(pageJobLog(log, "completed", 0)).toMatchObject({
    text: "a".repeat(jobLogChunkBytes),
    next: log.start + jobLogChunkBytes,
    complete: false,
    truncated: true,
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});

test.each([undefined, 0])(
  "range pages catch up within one chunk per request, after=%s",
  async (cursor) => {
    const bytes = Buffer.from("prefix" + "sample \u{1f6e0}\u00e9\n".repeat(450000));
    const fetch = logsFetch(bytes);
    let after = cursor;
    let text = "";
    let pages = 0;
    let start = bytes.length - jobLogWindowBytes;
    while (((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
    const expectedRanges = [`bytes=0-${jobLogChunkBytes + 3}`];
    let from = bytes.length - jobLogWindowBytes;
    while (true) {
      expectedRanges.push(`bytes=${from}-${from + jobLogChunkBytes + 3}`);
      const log = await client.downloadJobLog("test-secret", path, after);
      const chunk = pageJobLog(log, "completed", after);
      expect(chunk.truncated).toBe(pages === 0);
      expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(jobLogChunkBytes);
      expect(chunk.next).toBeGreaterThan(after ?? log.start);
      text += chunk.text;
      after = chunk.next;
      from = after;
      pages++;
      if (chunk.complete) break;
    }
    expect(text).toBe(bytes.subarray(start).toString("utf8"));
    expect(after).toBe(bytes.length);
    expect(pages).toBeGreaterThan(100);
    expect(
      fetch.mock.calls
        .filter(([url]) => String(url) === location)
        .map(([, init]) => new Headers(init?.headers).get("Range")),
    ).toEqual(expectedRanges);
    expect(fetch.transferredBytes()).toBeLessThanOrEqual((pages + 1) * (jobLogChunkBytes + 4));
  },
);

test("recent cursors use one bounded blob request per page", async () => {
  const bytes = Buffer.from("x".repeat(jobLogChunkBytes) + "\u{1f6e0}" + "tail");
  const fetch = logsFetch(bytes);
  const first = pageJobLog(await client.downloadJobLog("test-secret", path, 1), "completed", 1);
  expect(first).toMatchObject({
    text: "x".repeat(jobLogChunkBytes - 1),
    next: jobLogChunkBytes,
    complete: false,
    truncated: false,
  });
  const second = pageJobLog(
    await client.downloadJobLog("test-secret", path, first.next),
    "completed",
    first.next,
  );
  expect(second).toMatchObject({
    text: "\u{1f6e0}tail",
    next: bytes.length,
    complete: true,
    truncated: false,
  });
  expect(
    fetch.mock.calls
      .filter(([url]) => String(url) === location)
      .map(([, init]) => new Headers(init?.headers).get("Range")),
  ).toEqual([
    `bytes=1-${jobLogChunkBytes + 4}`,
    `bytes=${first.next}-${first.next + jobLogChunkBytes + 3}`,
  ]);
  expect(fetch.transferredBytes()).toBeLessThanOrEqual(2 * (jobLogChunkBytes + 4));
});

test.each([
  null,
  "bytes */unknown",
  "bytes */-1",
  "bytes */9007199254740992",
  "bytes */11",
  "bytes 0-9/10",
])("rejects an invalid unsatisfied range: %s", async (range) => {
  vi.stubGlobal("fetch", async (url: string | URL) =>
    String(url).startsWith("https://api.github.com/")
      ? new Response(null, { status: 302, headers: { Location: location } })
      : new Response(null, { status: 416, headers: range ? { "Content-Range": range } : {} }),
  );
  await expect(client.downloadJobLog("test-secret", path, 10)).rejects.toThrow("log byte range");
});

test("a range body cannot exceed the requested chunk and its stream is cancelled", async () => {
  const cancel = vi.fn();
  vi.stubGlobal("fetch", async (url: string | URL) =>
    String(url).startsWith("https://api.github.com/")
      ? new Response(null, { status: 302, headers: { Location: location } })
      : new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(jobLogChunkBytes + 5));
            },
            cancel,
          }),
          { status: 206, headers: { "Content-Range": `bytes 0-${jobLogChunkBytes + 3}/100000` } },
        ),
  );
  await expect(client.downloadJobLog("test-secret", path)).rejects.toThrow(
    "oversized log byte range",
  );
  expect(cancel).toHaveBeenCalledOnce();
});
