import { GitHubApiError } from "./app-client.js";
import type { JobLogs } from "../../protocol/src/jobs.js";

export const jobLogWindowBytes = 4 * 1024 * 1024;
export const jobLogDownloadBytes = 64 * 1024 * 1024;
// Six JSON bytes can represent one control byte, so even the worst chunk fits inspections.
export const jobLogChunkBytes = 32 * 1024;

function downloadUrl(location: string | null) {
  let url: URL;
  try {
    url = new URL(location ?? "");
  } catch {
    throw new Error("GitHub returned an invalid log download URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(
      url.hostname.endsWith(".actions.githubusercontent.com") ||
      /^[a-z0-9]+\.blob\.core\.windows\.net$/.test(url.hostname)
    )
  )
    throw new Error("GitHub returned an untrusted log download URL.");
  return url;
}

export async function downloadJobLog(token: string, path: string, after?: number) {
  if (
    path.includes("..") ||
    !/^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/actions\/jobs\/[1-9][0-9]*\/logs$/.test(path)
  )
    throw new Error("Invalid GitHub job log path.");
  if (after !== undefined && (!Number.isSafeInteger(after) || after < 0))
    throw new Error("Invalid job log byte cursor.");
  const signal = AbortSignal.timeout(10000);
  const redirect = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    redirect: "manual",
    signal,
  });
  await redirect.body?.cancel();
  if (redirect.status !== 302) throw new GitHubApiError(redirect.status);
  const url = downloadUrl(redirect.headers.get("Location"));
  const fetchBlob = (range: string) =>
    fetch(url, {
      headers: { Range: range, "Accept-Encoding": "identity" },
      redirect: "error",
      signal,
    });
  let response = await fetchBlob(
    after === undefined ? `bytes=-${jobLogWindowBytes}` : `bytes=${after}-`,
  );
  // An end cursor also yields 416. Fetch the tail to distinguish EOF from an invalid cursor.
  if (response.status === 416) {
    await response.body?.cancel();
    response = await fetchBlob(`bytes=-${jobLogWindowBytes}`);
    if (response.status === 416 && response.headers.get("Content-Range") === "bytes */0") {
      await response.body?.cancel();
      if (after !== undefined && after > 0) throw new Error("Job log cursor exceeds the log size.");
      return { bytes: Buffer.alloc(0), start: 0, total: 0 };
    }
  }
  if (response.status === 206 && after !== undefined) {
    const range = /^bytes [0-9]+-[0-9]+\/([0-9]+)$/.exec(
      response.headers.get("Content-Range") ?? "",
    );
    const total = Number(range?.[1]);
    if (Number.isSafeInteger(total) && total - after > jobLogWindowBytes) {
      await response.body?.cancel();
      response = await fetchBlob(`bytes=-${jobLogWindowBytes}`);
    }
  }
  if (response.status !== 200 && response.status !== 206) {
    await response.body?.cancel();
    throw new GitHubApiError(response.status);
  }
  if (
    response.headers.has("Content-Encoding") &&
    response.headers.get("Content-Encoding") !== "identity"
  ) {
    await response.body?.cancel();
    throw new Error("GitHub returned an encoded log; byte cursors require identity encoding.");
  }
  let start = 0;
  let total: number | undefined;
  if (response.status === 206) {
    const range = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(
      response.headers.get("Content-Range") ?? "",
    );
    if (!range) {
      await response.body?.cancel();
      throw new Error("GitHub returned an invalid log byte range.");
    }
    start = Number(range[1]);
    const end = Number(range[2]);
    total = Number(range[3]);
    if (![start, end, total].every(Number.isSafeInteger) || start > end || end !== total - 1) {
      await response.body?.cancel();
      throw new Error("GitHub returned an invalid log byte range.");
    }
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub returned no log body.");
  const tail = Buffer.alloc(jobLogWindowBytes);
  let size = 0;
  let position = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > jobLogDownloadBytes) throw new Error("GitHub log download exceeded 64 MiB.");
      if (value.byteLength >= tail.length) {
        tail.set(value.subarray(value.byteLength - tail.length));
        position = 0;
      } else {
        const first = Math.min(value.byteLength, tail.length - position);
        tail.set(value.subarray(0, first), position);
        tail.set(value.subarray(first), 0);
        position = (position + value.byteLength) % tail.length;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (total !== undefined && start + size !== total)
    throw new Error("GitHub returned an incomplete log byte range.");
  total ??= size;
  if (after !== undefined && after > total) throw new Error("Job log cursor exceeds the log size.");
  const retained = Math.min(size, tail.length);
  const bytes =
    size < tail.length
      ? tail.subarray(0, retained)
      : Buffer.concat([tail.subarray(position), tail.subarray(0, position)]);
  return { bytes, start: total - retained, total };
}

export function pageJobLog(
  log: Awaited<ReturnType<typeof downloadJobLog>>,
  status: JobLogs["status"],
  after?: number,
): JobLogs {
  let offset = Math.max(0, (after ?? log.start) - log.start);
  while (offset < log.bytes.length && ((log.bytes[offset] ?? 0) & 0xc0) === 0x80) offset++;
  let end = Math.min(offset + jobLogChunkBytes, log.bytes.length);
  if (end < log.bytes.length) {
    while (end > offset && ((log.bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  } else if (end > offset) {
    let lead = end - 1;
    while (lead > offset && ((log.bytes[lead] ?? 0) & 0xc0) === 0x80) lead--;
    const byte = log.bytes[lead] ?? 0;
    const length = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
    if (lead + length > end) {
      if (status === "completed") throw new Error("GitHub returned an incomplete UTF-8 log.");
      end = lead;
    }
  }
  const next = log.start + end;
  return {
    text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      log.bytes.subarray(offset, end),
    ),
    next,
    status,
    complete: status === "completed" && next === log.total,
    truncated: log.start > (after ?? 0),
  };
}
