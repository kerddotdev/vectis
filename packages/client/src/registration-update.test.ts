import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  recoverRegistration,
  replaceRegistration,
  withRegistrationLock,
} from "./registration-update.js";

async function fixture(run: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vectis-runtime-update-"));
  try {
    const path = join(root, "service.plist");
    await writeFile(path, "old-runtime");
    await run(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("busy service leaves its registration and runtime untouched", () =>
  fixture(async (path) => {
    const calls: string[] = [];
    await expect(
      replaceRegistration(path, "new-runtime", {
        stopIfIdle: async () => {
          throw new Error("busy");
        },
        unload: async () => {
          calls.push("unload");
        },
        start: async () => {
          calls.push("start");
        },
      }),
    ).rejects.toThrow("busy");
    expect(calls).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("old-runtime");
    await expect(readFile(`${path}.update-backup`)).rejects.toMatchObject({ code: "ENOENT" });
  }));

test("failed new runtime restores and starts the previous registration", () =>
  fixture(async (path) => {
    const starts: string[] = [];
    await expect(
      replaceRegistration(path, "new-runtime", {
        stopIfIdle: async () => {},
        unload: async () => {},
        start: async () => {
          const runtime = await readFile(path, "utf8");
          starts.push(runtime);
          if (runtime === "new-runtime") throw new Error("readiness failed");
        },
      }),
    ).rejects.toMatchObject({ code: "update_rolled_back" });
    expect(starts).toEqual(["new-runtime", "old-runtime"]);
    expect(await readFile(path, "utf8")).toBe("old-runtime");
    await expect(readFile(`${path}.update-backup`)).rejects.toMatchObject({ code: "ENOENT" });
  }));

test("interrupted update keeps recovery data until the old runtime starts", () =>
  fixture(async (path) => {
    await writeFile(`${path}.update-backup`, "old-runtime");
    await writeFile(path, "new-runtime");
    const runtime = {
      stopIfIdle: async () => {},
      unload: async () => {},
      start: async () => {
        throw Error("offline");
      },
    };
    await expect(recoverRegistration(path, runtime)).rejects.toThrow("offline");
    expect(await readFile(`${path}.update-backup`, "utf8")).toBe("old-runtime");
    await recoverRegistration(path, { ...runtime, start: async () => ({ running: true }) });
    expect(await readFile(path, "utf8")).toBe("old-runtime");
    await expect(readFile(`${path}.update-backup`)).rejects.toMatchObject({ code: "ENOENT" });
  }));

test("registration changes reject concurrent clients and release on failure", () =>
  fixture(async (path) => {
    await expect(
      withRegistrationLock(path, async () => {
        await expect(withRegistrationLock(path, async () => {})).rejects.toMatchObject({
          code: "service_control_busy",
        });
        throw Error("first client failed");
      }),
    ).rejects.toThrow("first client failed");
    await withRegistrationLock(path, async () => {});
  }));
