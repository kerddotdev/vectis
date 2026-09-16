import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { downloadArtifact, inspectLocalArtifact } from "./artifact.js";
const bytes = Buffer.from("verified-image-bytes");
const artifact = {
  url: "https://images.test/image",
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
async function fixture(run: (destination: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "vectis-download-"));
  try {
    await run(join(dir, "image"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("resumes partial bytes, verifies content and reuses the completed artifact", () =>
  fixture(async (destination) => {
    await writeFile(destination + ".part", bytes.subarray(0, 5));
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=5-");
      return new Response(bytes.subarray(5), {
        status: 206,
        headers: { "content-range": `bytes 5-${bytes.length - 1}/${bytes.length}` },
      });
    });
    await downloadArtifact(
      artifact,
      destination,
      new AbortController().signal,
      () => {},
      transport,
    );
    expect(await readFile(destination)).toEqual(bytes);
    await expect(stat(destination + ".part")).rejects.toMatchObject({ code: "ENOENT" });
    await downloadArtifact(
      artifact,
      destination,
      new AbortController().signal,
      () => {},
      transport,
    );
    expect(transport).toHaveBeenCalledOnce();
  }));
test("does not publish corrupt bytes and never overwrites existing data", () =>
  fixture(async (destination) => {
    const transport = vi.fn<typeof fetch>(async () => new Response(Buffer.alloc(bytes.length)));
    await expect(
      downloadArtifact(artifact, destination, new AbortController().signal, () => {}, transport),
    ).rejects.toMatchObject({ code: "artifact_integrity" });
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(destination, "user data");
    await expect(
      downloadArtifact(artifact, destination, new AbortController().signal, () => {}, transport),
    ).rejects.toMatchObject({ code: "artifact_conflict" });
    expect(await readFile(destination, "utf8")).toBe("user data");
  }));
test("server ignoring Range restarts only the owned partial file", () =>
  fixture(async (destination) => {
    await writeFile(destination + ".part", "old");
    await downloadArtifact(
      artifact,
      destination,
      new AbortController().signal,
      () => {},
      async () => new Response(bytes),
    );
    expect(await readFile(destination)).toEqual(bytes);
  }));
test("rejects downgraded redirects and mismatched resume ranges", () =>
  fixture(async (destination) => {
    await expect(
      downloadArtifact(
        artifact,
        destination,
        new AbortController().signal,
        () => {},
        async () =>
          new Response(null, { status: 302, headers: { location: "http://images.test/image" } }),
      ),
    ).rejects.toMatchObject({ code: "artifact_redirect" });
    await writeFile(destination + ".part", "short");
    await expect(
      downloadArtifact(
        artifact,
        destination,
        new AbortController().signal,
        () => {},
        async () =>
          new Response(bytes, {
            status: 206,
            headers: { "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}` },
          }),
      ),
    ).rejects.toMatchObject({ code: "artifact_range" });
  }));
test("rejects symlinks and preserves partial data on cancellation", () =>
  fixture(async (destination) => {
    const other = destination + "-other";
    await writeFile(other, "preserve");
    await symlink(other, destination + ".part");
    await expect(
      downloadArtifact(artifact, destination, new AbortController().signal),
    ).rejects.toThrow();
    expect(await readFile(other, "utf8")).toBe("preserve");
    await rm(destination + ".part");
    const abort = new AbortController();
    await expect(
      downloadArtifact(
        artifact,
        destination,
        abort.signal,
        () => abort.abort(),
        async () => new Response(bytes.subarray(0, 5)),
      ),
    ).rejects.toThrow();
    expect(await readFile(destination + ".part")).toEqual(bytes.subarray(0, 5));
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  }));

test("local installation fingerprints reject symlinks, empty media and cancelled reads", () =>
  fixture(async (destination) => {
    await writeFile(destination, bytes);
    expect(await inspectLocalArtifact(destination, AbortSignal.timeout(1000))).toEqual({
      sha256: artifact.sha256,
      bytes: bytes.length,
    });
    await symlink(destination, destination + ".link");
    await expect(
      inspectLocalArtifact(destination + ".link", AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ code: "ELOOP" });
    await expect(inspectLocalArtifact(destination, AbortSignal.abort())).rejects.toThrow();
    await writeFile(destination, "");
    await expect(
      inspectLocalArtifact(destination, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ code: "invalid_artifact" });
  }));
