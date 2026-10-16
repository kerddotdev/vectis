import { GitHubApiError } from "./api-request.js";
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
  const fetchPage = async (from: number) => {
    const requestedEnd = Math.min(Number.MAX_SAFE_INTEGER, from + jobLogChunkBytes + 3);
    const response = await fetchBlob(`bytes=${from}-${requestedEnd}`);
    if (response.status !== 200 && response.status !== 206 && response.status !== 416) {
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
    if (response.status === 200) return { response };
    const header = response.headers.get("Content-Range") ?? "";
    const range = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(header);
    const empty = /^bytes \*\/([0-9]+)$/.exec(header);
    const start = Number(range?.[1]);
    const end = Number(range?.[2]);
    const total = Number(response.status === 416 ? empty?.[1] : range?.[3]);
    if (
      !Number.isSafeInteger(total) ||
      total < 0 ||
      (response.status === 416
        ? !empty || from < total
        : !range ||
          ![start, end].every(Number.isSafeInteger) ||
          start !== from ||
          start > end ||
          end !== Math.min(requestedEnd, total - 1))
    ) {
      await response.body?.cancel();
      throw new Error("GitHub returned an invalid log byte range.");
    }
    return { response, range: { start, end, total } };
  };
  let page = await fetchPage(after ?? 0);
  if (page.range && page.response.status === 206) {
    const from = Math.max(after ?? 0, page.range.total - jobLogWindowBytes);
    if (from !== page.range.start) {
      await page.response.body?.cancel();
      page = await fetchPage(from);
    }
  }
  const { response, range } = page;
  if (response.status === 416 && range) {
    await response.body?.cancel();
    if (after !== undefined && after > range.total)
      throw new Error("Job log cursor exceeds the log size.");
    return { bytes: Buffer.alloc(0), start: range.total, total: range.total };
  }
  let total = range?.total;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub returned no log body.");
  const capacity = range ? range.end - range.start + 1 : jobLogWindowBytes;
  const tail = Buffer.alloc(capacity);
  let size = 0;
  let position = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (range && size > capacity) throw new Error("GitHub returned an oversized log byte range.");
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
  if (range && size !== capacity) throw new Error("GitHub returned an incomplete log byte range.");
  total ??= size;
  if (after !== undefined && after > total) throw new Error("Job log cursor exceeds the log size.");
  const retained = Math.min(size, tail.length);
  const bytes =
    size < tail.length
      ? tail.subarray(0, retained)
      : Buffer.concat([tail.subarray(position), tail.subarray(0, position)]);
  return { bytes, start: range?.start ?? total - retained, total };
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
