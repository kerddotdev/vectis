import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { prepareMacRestore, remainingMacRestoreBytes } from "./macos-restore.js";

test("restore downloads resume the same pinned source and reject a different owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "vectis-restore-"));
  const bytes = Buffer.from("isolated restore image");
  const source = {
    directory: join(root, "source"),
    owner: "setup-one",
    artifact: {
      url: "https://images.test/restore.ipsw",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
  const transport = vi.fn<typeof fetch>(async () => {
    throw new Error("Network unavailable");
  });
  try {
    await expect(
      prepareMacRestore(source, new AbortController().signal, () => {}, transport),
    ).rejects.toThrow("Network unavailable");
    await writeFile(join(source.directory, "restore.ipsw.part"), bytes.subarray(0, 5));
    expect(await remainingMacRestoreBytes(source)).toBe(bytes.length - 5);
    transport.mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=5-");
      return new Response(bytes.subarray(5), {
        status: 206,
        headers: { "content-range": `bytes 5-${bytes.length - 1}/${bytes.length}` },
      });
    });
    const path = await prepareMacRestore(source, new AbortController().signal, () => {}, transport);
    expect(await readFile(path)).toEqual(bytes);
    expect(await remainingMacRestoreBytes(source)).toBe(0);
    await prepareMacRestore(source, new AbortController().signal, () => {}, transport);
    expect(transport).toHaveBeenCalledTimes(2);
    await expect(
      prepareMacRestore(
        { ...source, owner: "other-setup" },
        new AbortController().signal,
        () => {},
        transport,
      ),
    ).rejects.toMatchObject({ code: "restore_directory_conflict" });
    expect(await readFile(path)).toEqual(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
