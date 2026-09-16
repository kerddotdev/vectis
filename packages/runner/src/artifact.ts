import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink, type FileHandle } from "node:fs/promises";
import { VectisError } from "../../protocol/src/index.js";

export interface Artifact {
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}
async function digest(file: FileHandle, signal: AbortSignal) {
  const hash = createHash("sha256");
  const stream = file.createReadStream({ start: 0, autoClose: false, signal });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}
export async function inspectLocalArtifact(path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size === 0)
      throw new VectisError(
        "invalid_artifact",
        "Installation media must be a non-empty regular file.",
      );
    const sha256 = await digest(file, signal);
    const after = await file.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new VectisError(
        "artifact_changed",
        "Installation media changed while it was being inspected.",
      );
    return { sha256, bytes: after.size };
  } finally {
    await file.close();
  }
}
export async function downloadArtifact(
  artifact: Artifact,
  destination: string,
  signal: AbortSignal,
  progress: (received: number) => void = () => {},
  transport: typeof fetch = fetch,
) {
  let url = new URL(artifact.url);
  const validUrl = (value: URL) =>
    value.protocol === "https:" && !value.username && !value.password;
  if (
    !validUrl(url) ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes < 1 ||
    artifact.bytes > 128 * 1024 ** 3
  )
    throw new VectisError(
      "invalid_artifact",
      "Expected an HTTPS artifact with a pinned SHA-256 and exact size.",
    );
  signal.throwIfAborted();
  const existing = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (existing) {
    try {
      if (
        (await existing.stat()).size !== artifact.bytes ||
        (await digest(existing, signal)) !== artifact.sha256
      )
        throw new VectisError(
          "artifact_conflict",
          "The destination already contains different data and was left untouched.",
        );
      progress(artifact.bytes);
      return;
    } finally {
      await existing.close();
    }
  }
  const partial = destination + ".part";
  const file = await open(
    partial,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = (await file.stat()).size;
    if (offset >= artifact.bytes) {
      if (offset === artifact.bytes && (await digest(file, signal)) === artifact.sha256) {
        await link(partial, destination);
        await unlink(partial);
        progress(offset);
        return;
      }
      await file.truncate(0);
      offset = 0;
    }
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects++) {
      signal.throwIfAborted();
      response = await transport(url, {
        redirect: "manual",
        headers: {
          "Accept-Encoding": "identity",
          ...(offset ? { Range: `bytes=${offset}-` } : {}),
        },
        signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 5)
        throw new VectisError("artifact_redirect", "The download redirect could not be followed.");
      url = new URL(location, url);
      if (!validUrl(url))
        throw new VectisError("artifact_redirect", "Artifact redirects must remain HTTPS.");
    }
    if (!response || ![200, 206].includes(response.status) || !response.body) {
      await response?.body?.cancel();
      throw new VectisError(
        "artifact_download_failed",
        "The artifact server did not provide a download.",
        "Retry preparation when the source is reachable. Partial bytes are retained.",
      );
    }
    const reader = response.body.getReader();
    try {
      if (
        response.headers.get("content-encoding") &&
        !/^identity$/i.test(response.headers.get("content-encoding") ?? "")
      )
        throw new VectisError("artifact_encoding", "Expected an unencoded artifact response.");
      if (response.status === 206) {
        const range = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        if (
          !range ||
          Number(range[1]) !== offset ||
          Number(range[2]) !== artifact.bytes - 1 ||
          Number(range[3]) !== artifact.bytes
        )
          throw new VectisError(
            "artifact_range",
            "The resumed download returned an unexpected byte range.",
          );
      } else if (offset) {
        await file.truncate(0);
        offset = 0;
      }
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) !== artifact.bytes - offset)
        throw new VectisError(
          "artifact_size",
          "The download size differs from the pinned artifact.",
        );
      let lastProgress = 0;
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        if (offset + value.length > artifact.bytes)
          throw new VectisError("artifact_size", "The download exceeded the pinned artifact size.");
        let written = 0;
        while (written < value.length) {
          const result = await file.write(value, written, value.length - written, offset);
          if (!result.bytesWritten)
            throw new VectisError("artifact_write_failed", "Artifact storage made no progress.");
          offset += result.bytesWritten;
          written += result.bytesWritten;
        }
        if (Date.now() - lastProgress >= 1000) {
          progress(offset);
          lastProgress = Date.now();
        }
      }
      await file.sync();
      if (offset !== artifact.bytes || (await digest(file, signal)) !== artifact.sha256)
        throw new VectisError(
          "artifact_integrity",
          "The downloaded artifact failed size or SHA-256 verification.",
          "Retry preparation; a complete corrupt partial file will be downloaded again.",
        );
      signal.throwIfAborted();
      await link(partial, destination);
      await unlink(partial);
      progress(offset);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } finally {
    await file.close();
  }
}
