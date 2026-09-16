import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { environmentRevision } from "./environment-revision.js";
import type { Environment } from "../../protocol/src/index.js";

test("image replacement and guest configuration changes invalidate previous evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vectis-image-revision-"));
  try {
    const basePath = join(directory, "base.img");
    await writeFile(basePath, "first");
    const environment: Environment = {
      id: "linux",
      name: "Linux",
      os: "linux",
      basePath,
      cpu: 2,
      memoryMiB: 2048,
      state: "ready",
    };
    const first = await environmentRevision(environment);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await environmentRevision(environment)).toBe(first);
    await writeFile(basePath, "replacement");
    const second = await environmentRevision(environment);
    expect(second).not.toBe(first);
    expect(await environmentRevision({ ...environment, sshUser: "different" })).not.toBe(second);
    expect(
      await environmentRevision({ ...environment, basePath: join(directory, "missing") }),
    ).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
