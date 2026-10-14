import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runnerStartScript } from "./runner-release.js";

const access = { repositoryId: 2, actors: "any", approval: "automatic" } as const;

test("rejects malformed JIT configuration before generating guest shell commands", () => {
  for (const config of ["", "token'; command", "$(command)", "line\nbreak", "a".repeat(60001)])
    for (const os of ["linux", "macos", "windows"] as const)
      expect(() => runnerStartScript(os, config, access)).toThrow("configuration is invalid");
});

test("jobs keep the guest umask while the assignment gate stays private", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-runner-umask-"));
  try {
    await mkdir(join(home, "vectis-actions-runner"));
    await writeFile(join(home, "vectis-actions-runner/run.sh"), "#!/bin/bash\numask\n", {
      mode: 0o700,
    });
    await writeFile(join(home, "start.sh"), runnerStartScript("linux", "c2VjcmV0", access));
    const result = spawnSync("bash", ["-c", 'umask 022; exec bash "$0"', join(home, "start.sh")], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0022");
    expect((await stat(join(home, "vectis-actions-runner/_vectis/policy"))).mode & 0o777).toBe(
      0o600,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
