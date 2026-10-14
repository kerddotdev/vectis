import { afterEach, expect, test, vi } from "vitest";
import { GitHubAppClient } from "./app-client.js";
import { jobLogWindowBytes, jobLogChunkBytes, pageJobLog } from "./job-logs.js";

const client = new GitHubAppClient({ appId: 1, clientId: "test", privateKey: "unused" });
const path = "/repos/owner/repo/actions/jobs/4/logs";
const location = "https://productionresultssa0.blob.core.windows.net/logs/job?signed=test";
afterEach(() => vi.unstubAllGlobals());

function logsFetch(bytes: Uint8Array, ranges = true) {
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (String(url).startsWith("https://api.github.com/")) {
      expect(headers.get("Authorization")).toBe("Bearer test-secret");
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { Location: location } });
    }
    expect(headers.has("Authorization")).toBe(false);
    expect(init?.redirect).toBe("error");
    const range = headers.get("Range") ?? "";
    if (!ranges) return new Response(bytes.slice());
    const start = range.startsWith("bytes=-")
      ? Math.max(0, bytes.length - Number(range.slice(7)))
      : Number(range.slice(6, -1));
    if (start >= bytes.length)
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${bytes.length}` },
      });
    return new Response(bytes.slice(start), {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
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
  expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("Range")).toBe("bytes=3-");
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
  for (const range of ["bytes 0-9/*", "bytes 0-4/10", "bytes 0-9/10"]) {
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
    if (range === "bytes=0-")
      return new Response("discarded", {
        status: 206,
        headers: { "Content-Range": `bytes 0-${total - 1}/${total}` },
      });
    expect(range).toBe(`bytes=-${jobLogWindowBytes}`);
    return new Response(new Uint8Array(jobLogWindowBytes).fill(97), {
      status: 206,
      headers: { "Content-Range": `bytes ${total - jobLogWindowBytes}-${total - 1}/${total}` },
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
