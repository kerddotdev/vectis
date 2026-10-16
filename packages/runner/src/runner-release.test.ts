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
    await mkdir(join(home, "vectis-actions-runner/bin"), { recursive: true });
    await writeFile(
      join(home, "vectis-actions-runner/bin/Runner.Listener"),
      "#!/bin/bash\numask\n",
      {
        mode: 0o700,
      },
    );
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

test.each(["linux", "macos"] as const)(
  "%s exposes fatal and deprecated listener exit codes without run.sh rewriting them",
  async (os) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-runner-exit-"));
    try {
      const directory = join(home, "vectis-actions-runner");
      await mkdir(join(directory, "bin"), { recursive: true });
      await writeFile(join(directory, "run.sh"), "#!/bin/bash\nexit 0\n", { mode: 0o700 });
      await writeFile(
        join(directory, "bin/Runner.Listener"),
        '#!/bin/bash\ntest "$ACTIONS_RUNNER_RETURN_VERSION_DEPRECATED_EXIT_CODE" = 1 || exit 99\nexit "$VECTIS_TEST_RUNNER_EXIT"\n',
        { mode: 0o700 },
      );
      for (const code of [0, 1, 5]) {
        const result = spawnSync("bash", ["-c", runnerStartScript(os, "c2VjcmV0", access)], {
          env: { ...process.env, HOME: home, VECTIS_TEST_RUNNER_EXIT: String(code) },
          encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(code);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("Windows enables deprecated-version errors and propagates the native listener exit", () => {
  const script = runnerStartScript("windows", "c2VjcmV0", access);
  expect(script).toContain("$env:ACTIONS_RUNNER_RETURN_VERSION_DEPRECATED_EXIT_CODE = '1'");
  expect(script).toContain("Runner.Listener.exe run --jitconfig");
  expect(script).toContain("$runnerExit = $LASTEXITCODE");
  expect(script).toContain("exit $runnerExit");
});
