import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  renderRunnerPolicy,
  bashJobStartedHook,
  powershellJobStartedHook,
  assignmentRejectedMarker,
} from "./runner-access.js";
import type { RunnerAccess } from "../../protocol/src/repository-access.js";
import { runnerStartScript } from "./runner-release.js";

const restrictive: RunnerAccess = {
  repositoryId: 2,
  actors: { ids: [7, 8] },
  approval: "required",
  approvedRun: { runId: 5, runAttempt: 1 },
};
const env = {
  GITHUB_REPOSITORY_ID: "2",
  GITHUB_ACTOR_ID: "7",
  GITHUB_TRIGGERING_ACTOR: "sender",
  GITHUB_RUN_ID: "5",
  GITHUB_RUN_ATTEMPT: "1",
};
const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;
const cases = [
  { name: "allowed", overrides: {}, event: { sender: { id: 8, login: "sender" } }, allowed: true },
  {
    name: "wrong repository",
    overrides: { GITHUB_REPOSITORY_ID: "99" },
    event: { sender: { id: 8, login: "sender" } },
    allowed: false,
  },
  {
    name: "wrong actor",
    overrides: { GITHUB_ACTOR_ID: "9" },
    event: { sender: { id: 8, login: "sender" } },
    allowed: false,
  },
  {
    name: "wrong triggering actor",
    overrides: {},
    event: { sender: { id: 9, login: "sender" } },
    allowed: false,
  },
  {
    name: "wrong run",
    overrides: { GITHUB_RUN_ID: "6" },
    event: { sender: { id: 8, login: "sender" } },
    allowed: false,
  },
  {
    name: "wrong run attempt",
    overrides: { GITHUB_RUN_ATTEMPT: "2" },
    event: { sender: { id: 8, login: "sender" } },
    allowed: false,
  },
  { name: "missing triggering actor", overrides: {}, event: {}, allowed: false },
  {
    name: "sender differs from triggering actor",
    overrides: {},
    event: { sender: { id: 8, login: "other" } },
    allowed: false,
  },
  {
    name: "boolean sender id",
    overrides: {},
    event: { sender: { id: true, login: "sender" } },
    allowed: false,
  },
  {
    name: "string sender id",
    overrides: {},
    event: { sender: { id: "8", login: "sender" } },
    allowed: false,
  },
];
for (const shell of ["bash", "pwsh"] as const) {
  test.skipIf(shell === "pwsh" && !pwsh).each(cases)(
    `${shell} hook: $name`,
    async ({ overrides, event, allowed }) => {
      const home = await mkdtemp(join(tmpdir(), "vectis-access-hook-"));
      try {
        const hook = join(home, shell === "bash" ? "job-started.sh" : "job-started.ps1");
        const eventPath = join(home, "event.json");
        await writeFile(join(home, "policy"), renderRunnerPolicy(restrictive));
        await writeFile(hook, shell === "bash" ? bashJobStartedHook() : powershellJobStartedHook());
        await writeFile(eventPath, JSON.stringify(event));
        const result = spawnSync(shell, shell === "bash" ? [hook] : ["-NoProfile", "-File", hook], {
          env: { ...process.env, ...env, ...overrides, GITHUB_EVENT_PATH: eventPath },
          encoding: "utf8",
        });
        expect(result.status, result.stdout + result.stderr).toBe(allowed ? 0 : 1);
        if (!allowed) {
          expect(result.stdout).toContain("::error::Vectis refused this job:");
          expect(result.stdout).toContain(assignmentRejectedMarker);
          expect(await readFile(join(home, "rejected"), "utf8")).toContain(
            assignmentRejectedMarker,
          );
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
}

test("policy rendering validates integers, actor bounds and approval scope before shell interpolation", () => {
  expect(renderRunnerPolicy({ ...restrictive, actors: { ids: [7, 7, 8] } })).toContain(
    "actors=7,8",
  );
  for (const repositoryId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2; touch injected"])
    expect(() => renderRunnerPolicy({ ...restrictive, repositoryId })).toThrow();
  for (const ids of [[0], [1.5], ["$(whoami)"], Array.from({ length: 101 }, (_, i) => i + 1)])
    expect(() => renderRunnerPolicy({ ...restrictive, actors: { ids } })).toThrow();
  expect(() =>
    renderRunnerPolicy({ repositoryId: 2, actors: "any", approval: "required" }),
  ).toThrow();
  expect(() => renderRunnerPolicy({ ...restrictive, approval: "automatic" })).toThrow();
});

test("the start wrapper surfaces the hook's refusal even after a successful listener exit", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-access-wrapper-"));
  const { mkdir } = await import("node:fs/promises");
  try {
    await mkdir(join(home, "vectis-actions-runner"));
    await writeFile(join(home, "event.json"), "{}");
    await writeFile(
      join(home, "vectis-actions-runner/run.sh"),
      '#!/bin/bash\nbash "$ACTIONS_RUNNER_HOOK_JOB_STARTED"\nexit 0\n',
      { mode: 0o700 },
    );
    const script = join(home, "start.sh");
    await writeFile(
      script,
      runnerStartScript("linux", "c2VjcmV0", {
        repositoryId: 2,
        actors: "any",
        approval: "automatic",
      }),
    );
    const result = spawnSync("bash", [script], {
      env: { ...process.env, HOME: home, GITHUB_REPOSITORY_ID: "99" },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout.trim().split("\n").at(-1)).toBe(assignmentRejectedMarker);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test.each([true, false])(
  "bash uses python3 fallback or refuses without a JSON parser (python: %s)",
  async (python) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-access-parser-"));
    try {
      await symlink("/usr/bin/dirname", join(home, "dirname"));
      if (python) {
        const path = spawnSync("/usr/bin/which", ["python3"], { encoding: "utf8" }).stdout.trim();
        expect(path).not.toBe("");
        await symlink(path, join(home, "python3"));
      }
      await writeFile(join(home, "policy"), renderRunnerPolicy(restrictive));
      await writeFile(join(home, "hook.sh"), bashJobStartedHook());
      await writeFile(
        join(home, "event.json"),
        JSON.stringify({ sender: { id: 8, login: "sender" } }),
      );
      const result = spawnSync("/bin/bash", [join(home, "hook.sh")], {
        env: { ...process.env, ...env, PATH: home, GITHUB_EVENT_PATH: join(home, "event.json") },
        encoding: "utf8",
      });
      expect(result.status, result.stdout + result.stderr).toBe(python ? 0 : 1);
      if (!python) expect(result.stdout).toContain("JSON parser unavailable");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

for (const shell of ["bash", "pwsh"] as const) {
  test.skipIf(shell === "pwsh" && !pwsh).each(["2", "99"])(
    `${shell} unrestricted hook checks only repository ID %s`,
    async (repositoryId) => {
      const home = await mkdtemp(join(tmpdir(), "vectis-access-default-"));
      try {
        const hook = join(home, shell === "bash" ? "hook.sh" : "hook.ps1");
        await writeFile(
          join(home, "policy"),
          renderRunnerPolicy({ repositoryId: 2, actors: "any", approval: "automatic" }),
        );
        await writeFile(hook, shell === "bash" ? bashJobStartedHook() : powershellJobStartedHook());
        const result = spawnSync(shell, shell === "bash" ? [hook] : ["-NoProfile", "-File", hook], {
          env: { PATH: process.env.PATH, GITHUB_REPOSITORY_ID: repositoryId },
          encoding: "utf8",
        });
        expect(result.status, result.stdout + result.stderr).toBe(repositoryId === "2" ? 0 : 1);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
}
