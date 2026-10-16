import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Store } from "./store.js";
import { cacheGuestPrivilege, recordCacheGuestPrivilege } from "./cache-guest-privilege.js";

test("cache privilege observations survive restart and apply only to the probed image and guest user", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-cache-privilege-"));
  const path = join(home, "state.sqlite");
  const environment = {
    id: "linux",
    name: "Linux",
    os: "linux",
    state: "ready",
    basePath: join(home, "base.img"),
    cpu: 1,
    memoryMiB: 512,
  } as const;
  let store = new Store(path);
  try {
    expect(cacheGuestPrivilege(store, environment)).toBeUndefined();
    recordCacheGuestPrivilege(store, environment, false);
    store.close();
    store = new Store(path);
    expect(cacheGuestPrivilege(store, environment)).toBe(false);
    expect(cacheGuestPrivilege(store, { ...environment, cpu: 2 })).toBe(false);
    expect(
      cacheGuestPrivilege(store, { ...environment, basePath: join(home, "new.img") }),
    ).toBeUndefined();
    expect(cacheGuestPrivilege(store, { ...environment, sshUser: "new-user" })).toBeUndefined();
    expect(
      cacheGuestPrivilege(store, {
        ...environment,
        image: { revision: "new", provisionedAt: "now" },
      }),
    ).toBeUndefined();
    recordCacheGuestPrivilege(store, environment, true);
    expect(cacheGuestPrivilege(store, environment)).toBe(true);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
