import { mkdtemp, chmod, lstat, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startService } from "./http.js";
import { privateHome, privateFile } from "./private-files.js";
import { Store } from "./store.js";
import { execFileSync } from "node:child_process";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
async function home() {
  const directory = await mkdtemp(join(tmpdir(), "vectis-private-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
test("existing permissive homes and metadata become private without losing durable state", async () => {
  const directory = await home();
  await chmod(directory, 0o755);
  await writeFile(join(directory, "connection.json"), "old connection", { mode: 0o644 });
  const old = new Store(join(directory, "state.sqlite"));
  old.put("fixture", "preserved", { value: 17 });
  old.close();
  await chmod(join(directory, "state.sqlite"), 0o644);
  const server = await startService({ home: directory });
  cleanup.push(server.close);
  expect(server.store.get("fixture", "preserved")).toEqual({ value: 17 });
  expect((await lstat(directory)).mode & 0o777).toBe(0o700);
  const connection = await lstat(join(directory, "connection.json"));
  expect(connection.isSymbolicLink()).toBe(false);
  expect(connection.mode & 0o777).toBe(0o600);
  for (const name of ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"])
    expect((await lstat(join(directory, name))).mode & 0o777).toBe(0o600);
});
test("SQLite creation remains private with a permissive ambient umask", async () => {
  const directory = await home();
  const previous = process.umask(0o022);
  try {
    const store = new Store(join(directory, "state.sqlite"));
    try {
      for (const name of ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"])
        expect((await lstat(join(directory, name))).mode & 0o777).toBe(0o600);
    } finally {
      store.close();
    }
  } finally {
    process.umask(previous);
  }
});
test("symlinked metadata, database and homes fail before touching their targets", async () => {
  const directory = await home();
  const target = join(directory, "untouched");
  await writeFile(target, "preserved", { mode: 0o644 });
  await symlink(target, join(directory, "connection.json"));
  await expect(startService({ home: directory })).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("preserved");
  expect((await lstat(target)).mode & 0o777).toBe(0o644);
  await symlink(target, join(directory, "state.sqlite"));
  expect(() => new Store(join(directory, "state.sqlite"))).toThrow();
  await rm(join(directory, "connection.json"));
  await expect(startService({ home: directory })).rejects.toThrow();
  await expect(lstat(join(directory, "service.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(target, "utf8")).toBe("preserved");
  const link = `${directory}-link`;
  cleanup.push(() => rm(link, { force: true }));
  await symlink(directory, link);
  expect(() => privateHome(link)).toThrow();
});
test.skipIf(process.platform === "win32")(
  "non-regular service files are rejected without waiting for a writer",
  async () => {
    const directory = await home();
    const path = join(directory, "state.sqlite");
    execFileSync("mkfifo", [path]);
    expect(() => privateFile(path)).toThrow("regular files");
  },
);
test.skipIf(!process.getuid)(
  "a foreign-owned home is rejected before changing permissions",
  async () => {
    const directory = await home();
    await chmod(directory, 0o755);
    const uid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect(() => privateHome(directory)).toThrow("owned by the current user");
    expect((await lstat(directory)).mode & 0o777).toBe(0o755);
  },
);
