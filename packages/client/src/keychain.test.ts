import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { KeychainCredentials } from "./keychain.js";

test("cancelling credential access reaps its owned helper before returning", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-keychain-test-"));
  const abort = new AbortController();
  try {
    const helper = join(home, "helper");
    const pidFile = join(home, "pid");
    await writeFile(
      helper,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
      { mode: 0o700 },
    );
    const pending = new KeychainCredentials(helper).get("test-account", abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const pid = await vi.waitFor(async () => Number(await readFile(pidFile, "utf8")));
    abort.abort();
    await rejected;
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    abort.abort();
    await rm(home, { recursive: true, force: true });
  }
});
