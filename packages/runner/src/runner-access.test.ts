import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  renderRunnerPolicy,
  bashJobStartedHook,
  powershellJobStartedHook,
  assignmentRejectedMarker,
  assignmentRejectedPath,
  runnerGateScript,
  jobStartedMarker,
  jobStartedPath,
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
        await mkdir(join(home, "vectis-actions-runner/_vectis"), { recursive: true });
        const result = await runHook(shell, hook, {
          ...process.env,
          ...env,
          ...overrides,
          HOME: home,
          USERPROFILE: home,
          GITHUB_EVENT_PATH: eventPath,
        });
        expect(result.status, result.stdout + result.stderr).toBe(allowed ? 0 : null);
        if (allowed) {
          const timestamp = Number(await readFile(join(home, jobStartedPath), "utf8"));
          expect(timestamp).toBeGreaterThan(Date.now() - 10000);
          expect(timestamp).toBeLessThanOrEqual(Date.now());
          await expect(readFile(join(home, `${jobStartedPath}.tmp`))).rejects.toMatchObject({
            code: "ENOENT",
          });
        } else {
          expect(result.stdout).toContain("::error::Vectis refused this job:");
          expect(result.stdout).toContain(assignmentRejectedMarker);
          expect(await readFile(join(home, assignmentRejectedPath), "utf8")).toMatch(
            /mismatch|not allowed|unavailable/,
          );
          await expect(readFile(join(home, jobStartedPath))).rejects.toMatchObject({
            code: "ENOENT",
          });
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

test.each(["1760572800123", "17605728003N"])(
  "bash records epoch milliseconds atomically with date output %s",
  async (dateOutput) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-access-start-"));
    try {
      const gate = join(home, "vectis-actions-runner/_vectis");
      await mkdir(gate, { recursive: true });
      await writeFile(
        join(gate, "policy"),
        renderRunnerPolicy({ repositoryId: 2, actors: "any", approval: "automatic" }),
      );
      await writeFile(join(gate, "hook.sh"), bashJobStartedHook());
      await writeFile(join(home, "date"), `#!/bin/sh\nprintf '%s\\n' '${dateOutput}'\n`, {
        mode: 0o700,
      });
      await writeFile(join(home, "perl"), "#!/bin/sh\nprintf '1760572800456\\n'\n", {
        mode: 0o700,
      });
      await writeFile(
        join(home, "mv"),
        `#!/bin/sh
test ! -e "$3" || exit 1
test -f "$2" || exit 1
exec /bin/mv "$@"
`,
        { mode: 0o700 },
      );
      const result = await runHook("bash", join(gate, "hook.sh"), {
        ...process.env,
        HOME: home,
        GITHUB_REPOSITORY_ID: "2",
        PATH: `${home}:${process.env.PATH}`,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(await readFile(join(home, jobStartedPath), "utf8")).toBe(
        `${dateOutput.endsWith("N") ? "1760572800456" : dateOutput}\n`,
      );
      await expect(readFile(join(home, `${jobStartedPath}.tmp`))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("timestamp write failure does not refuse an allowed assignment", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-access-start-failure-"));
  try {
    await writeFile(
      join(home, "policy"),
      renderRunnerPolicy({ repositoryId: 2, actors: "any", approval: "automatic" }),
    );
    await writeFile(join(home, "hook.sh"), bashJobStartedHook());
    const result = await runHook("bash", join(home, "hook.sh"), {
      ...process.env,
      HOME: home,
      GITHUB_REPOSITORY_ID: "2",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(assignmentRejectedMarker);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the start wrapper installs the marker directory and a refused hook never returns", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-access-wrapper-"));
  try {
    await mkdir(join(home, "vectis-actions-runner/bin"), { recursive: true });
    await writeFile(join(home, "event.json"), "{}");
    await writeFile(
      join(home, "vectis-actions-runner/bin/Runner.Listener"),
      '#!/bin/bash\nbash "$ACTIONS_RUNNER_HOOK_JOB_STARTED"\nprintf step-ran\nexit 0\n',
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
    const result = await runHook("bash", script, {
      ...process.env,
      HOME: home,
      GITHUB_REPOSITORY_ID: "99",
    });
    expect(result.status).toBe(null);
    expect(result.stdout).toContain(assignmentRejectedMarker);
    expect(result.stdout).not.toContain("step-ran");
    expect(await readFile(join(home, assignmentRejectedPath), "utf8")).toBe(
      "repository id mismatch\n",
    );
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
      await mkdir(join(home, "vectis-actions-runner/_vectis"), { recursive: true });
      await symlink("/bin/sleep", join(home, "sleep"));
      await symlink("/bin/mv", join(home, "mv"));
      const result = await runHook("bash", join(home, "hook.sh"), {
        ...process.env,
        ...env,
        HOME: home,
        PATH: home,
        GITHUB_EVENT_PATH: join(home, "event.json"),
      });
      expect(result.status, result.stdout + result.stderr).toBe(python ? 0 : null);
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
        await mkdir(join(home, "vectis-actions-runner/_vectis"), { recursive: true });
        const result = await runHook(shell, hook, {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          GITHUB_REPOSITORY_ID: repositoryId,
        });
        expect(result.status, result.stdout + result.stderr).toBe(repositoryId === "2" ? 0 : null);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
}

async function stopOwnedGroup(child: ChildProcess) {
  if (!child.pid) return;
  const closed =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
  await closed;
}

async function runHook(shell: "bash" | "pwsh", hook: string, environment: NodeJS.ProcessEnv) {
  const child = spawn(
    shell === "bash" ? "/bin/bash" : "pwsh",
    shell === "bash" ? [hook] : ["-NoProfile", "-File", hook],
    {
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  let blocked: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", () => resolve());
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
        if (!blocked && stdout.includes(assignmentRejectedMarker))
          blocked = setTimeout(resolve, 200);
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      timeout = setTimeout(() => reject(new Error(`Hook timed out: ${stdout} ${stderr}`)), 5000);
    });
    return { status: child.exitCode, stdout, stderr };
  } finally {
    clearTimeout(blocked);
    clearTimeout(timeout);
    await stopOwnedGroup(child);
  }
}

const processHarness = `#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc < 4) return 2;
  FILE *record = fopen(argv[1], "a");
  if (!record) return 3;
  fprintf(record, "%d %s\\n", getpid(), argv[0]);
  fclose(record);
  const char *proc = getenv("VECTIS_TEST_PROC");
  if (proc) {
    char directory[4096], path[4096];
    snprintf(directory, sizeof(directory), "%s/%d", proc, getpid());
    mkdir(directory, 0700);
    snprintf(path, sizeof(path), "%s/stat", directory);
    FILE *stat = fopen(path, "w");
    if (!stat) return 6;
    const char *name = strrchr(argv[0], '/');
    fprintf(stat, "%d (%s) S %d 0\\n", getpid(), name ? name + 1 : argv[0], getppid());
    fclose(stat);
  }
  pid_t child = fork();
  if (child == 0) { execvp(argv[3], &argv[3]); _exit(4); }
  if (child < 0) return 5;
  int status;
  waitpid(child, &status, 0);
  FILE *step = strstr(argv[0], "Worker") ? fopen(argv[2], "w") : NULL;
  if (step) { fputs("step ran", step); fclose(step); }
  return 0;
}
`;

// Real process trees are slow to start and reap on a loaded CI guest.
const processTreeTimeout = 30000;

for (const mode of ["bash", "bash-proc", "bash-kill-failure", "pwsh"] as const) {
  const shell = mode === "pwsh" ? "pwsh" : "bash";
  test.skipIf(shell === "pwsh" && !pwsh)(
    `${mode} rejection never runs a later step or stops a sibling`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), "vectis-access-tree-"));
      let listener: ChildProcess | undefined;
      const sibling = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
      try {
        const gate = join(home, "vectis-actions-runner/_vectis");
        await mkdir(gate, { recursive: true });
        const source = join(home, "process.c");
        const listenerPath = join(
          home,
          shell === "bash" ? "Runner.Listener" : "Runner.Listener.exe",
        );
        const workerPath = join(home, shell === "bash" ? "Runner.Worker" : "Runner.Worker.exe");
        await writeFile(source, processHarness);
        const compiled = spawnSync("cc", [source, "-o", listenerPath], { encoding: "utf8" });
        expect(compiled.status, compiled.stderr).toBe(0);
        await copyFile(listenerPath, workerPath);
        const hook = join(gate, shell === "bash" ? "hook.sh" : "hook.ps1");
        // Win32_Process is unavailable on Unix; the shim reads the same live parent tree.
        const cim = `function Get-CimInstance {
  param($ClassName, $Filter)
  $target = [int]($Filter -replace 'ProcessId = ', '')
  $parent = & /bin/ps -o ppid= -p $target
  $name = & /bin/ps -o comm= -p $target
  if ($LASTEXITCODE -ne 0) { throw 'Process unavailable' }
  [pscustomobject]@{ ParentProcessId = [int]$parent.Trim(); Name = (Split-Path $name.Trim() -Leaf) }
}
`;
        const proc = join(home, "proc");
        if (mode === "bash-proc") await mkdir(proc);
        let content = shell === "bash" ? bashJobStartedHook() : cim + powershellJobStartedHook();
        if (mode === "bash-proc") content = content.replaceAll("/proc/", `${proc}/`);
        if (mode === "bash-kill-failure") content = "kill() { return 1; }\n" + content;
        await writeFile(hook, content);
        await writeFile(join(gate, "policy"), renderRunnerPolicy(restrictive));
        const pids = join(home, "pids");
        const step = join(home, "step-ran");
        listener = spawn(
          listenerPath,
          [
            pids,
            step,
            workerPath,
            pids,
            step,
            shell === "bash" ? "/bin/bash" : "pwsh",
            ...(shell === "bash" ? [hook] : ["-NoProfile", "-File", hook]),
          ],
          {
            env: {
              ...process.env,
              HOME: home,
              USERPROFILE: home,
              GITHUB_REPOSITORY_ID: "99",
              ...(mode === "bash-proc" ? { VECTIS_TEST_PROC: proc } : {}),
            },
            detached: true,
            stdio: "ignore",
          },
        );
        const ownedListener = listener;
        if (mode === "bash-kill-failure") {
          await expect
            .poll(() => readFile(join(home, assignmentRejectedPath), "utf8").catch(() => ""), {
              timeout: 15000,
            })
            .toBe("repository id mismatch\n");
          await new Promise((resolve) => setTimeout(resolve, 200));
          expect(ownedListener.signalCode).toBe(null);
        } else {
          await expect.poll(() => ownedListener.signalCode, { timeout: 15000 }).toBe("SIGKILL");
        }
        const worker = (await readFile(pids, "utf8"))
          .split("\n")
          .find((line) => line.endsWith(workerPath))
          ?.split(" ")[0];
        expect(worker).toMatch(/^[0-9]+$/);
        const state = spawnSync("/bin/ps", ["-o", "stat=", "-p", worker ?? "0"], {
          encoding: "utf8",
        });
        if (mode === "bash-kill-failure") expect(state.stdout.trim()).not.toMatch(/^Z|^$/);
        else expect(state.stdout.trim()).toMatch(/^Z|^$/);
        expect(await readFile(join(home, assignmentRejectedPath), "utf8")).toBe(
          "repository id mismatch\n",
        );
        await expect(readFile(step)).rejects.toMatchObject({ code: "ENOENT" });
        expect(sibling.exitCode).toBe(null);
        expect(sibling.signalCode).toBe(null);
        if (!sibling.pid) throw new Error("Sibling not spawned");
        const siblingPid = sibling.pid;
        expect(() => process.kill(siblingPid, 0)).not.toThrow();
      } finally {
        if (listener) await stopOwnedGroup(listener);
        const closed = new Promise<void>((resolve) => sibling.once("close", () => resolve()));
        sibling.kill("SIGKILL");
        await closed;
        await rm(home, { recursive: true, force: true });
      }
    },
    processTreeTimeout,
  );
}

test(
  "a distant Runner.Worker ancestor is never stopped",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "vectis-access-distant-"));
    let listener: ChildProcess | undefined;
    try {
      const gate = join(home, "vectis-actions-runner/_vectis");
      await mkdir(gate, { recursive: true });
      const source = join(home, "process.c");
      const listenerPath = join(home, "Runner.Listener");
      const workerPath = join(home, "Runner.Worker");
      const middlePath = join(home, "Middle");
      await writeFile(source, processHarness);
      const compiled = spawnSync("cc", [source, "-o", listenerPath], { encoding: "utf8" });
      expect(compiled.status, compiled.stderr).toBe(0);
      await copyFile(listenerPath, workerPath);
      await copyFile(listenerPath, middlePath);
      const hook = join(gate, "hook.sh");
      await writeFile(hook, bashJobStartedHook());
      await writeFile(join(gate, "policy"), renderRunnerPolicy(restrictive));
      const pids = join(home, "pids");
      const step = join(home, "step-ran");
      const middles = Array.from({ length: 4 }, () => [middlePath, pids, step]).flat();
      listener = spawn(
        listenerPath,
        [pids, step, workerPath, pids, step, ...middles, "/bin/bash", hook],
        {
          env: { ...process.env, HOME: home, GITHUB_REPOSITORY_ID: "99" },
          detached: true,
          stdio: "ignore",
        },
      );
      const ownedListener = listener;
      await expect
        .poll(() => readFile(join(home, assignmentRejectedPath), "utf8").catch(() => ""), {
          timeout: 15000,
        })
        .toBe("repository id mismatch\n");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(ownedListener.signalCode).toBe(null);
      const worker = (await readFile(pids, "utf8"))
        .split("\n")
        .find((line) => line.endsWith(workerPath))
        ?.split(" ")[0];
      const state = spawnSync("/bin/ps", ["-o", "stat=", "-p", worker ?? "0"], {
        encoding: "utf8",
      });
      expect(state.stdout.trim()).not.toMatch(/^Z|^$/);
    } finally {
      if (listener) await stopOwnedGroup(listener);
      await rm(home, { recursive: true, force: true });
    }
  },
  processTreeTimeout,
);

test.each(["ancestry", "marker", "policy"])(
  "failed %s handling blocks the hook instead of returning control",
  async (failure) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-access-ancestry-"));
    try {
      if (failure !== "marker")
        await mkdir(join(home, "vectis-actions-runner/_vectis"), { recursive: true });
      await symlink("/usr/bin/dirname", join(home, "dirname"));
      await symlink("/bin/sleep", join(home, "sleep"));
      await symlink("/bin/mv", join(home, "mv"));
      await writeFile(join(home, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      await writeFile(
        join(home, "policy"),
        failure === "policy" ? "" : renderRunnerPolicy(restrictive),
      );
      const hook = join(home, "hook.sh");
      await writeFile(hook, bashJobStartedHook());
      const result = await runHook("bash", hook, {
        HOME: home,
        PATH: home,
        GITHUB_REPOSITORY_ID: "99",
      });
      expect(result.status).toBe(null);
      expect(result.stdout).toContain(assignmentRejectedMarker);
      if (failure !== "marker")
        expect(await readFile(join(home, assignmentRejectedPath), "utf8")).toBe(
          failure === "policy" ? "policy verification failed\n" : "repository id mismatch\n",
        );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  processTreeTimeout,
);

for (const os of ["linux", "macos", "windows"] as const) {
  test.skipIf(os === "windows" && !pwsh)(
    `${os} host probe reads job start and the fixed rejection reason`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), "vectis-access-probe-"));
      try {
        const script = join(home, os === "windows" ? "probe.ps1" : "probe.sh");
        const executable = os === "windows" ? "pwsh" : "bash";
        const args = os === "windows" ? ["-NoProfile", "-File", script] : [script];
        await writeFile(script, runnerGateScript(os));
        expect(
          spawnSync(executable, args, {
            env: { ...process.env, HOME: home, USERPROFILE: home },
            encoding: "utf8",
          }).stdout,
        ).toBe("");
        await mkdir(join(home, "vectis-actions-runner/_vectis"), { recursive: true });
        await writeFile(join(home, assignmentRejectedPath), "actor not allowed\n");
        expect(
          spawnSync(executable, args, {
            env: { ...process.env, HOME: home, USERPROFILE: home },
            encoding: "utf8",
          }).stdout,
        ).toBe(`${assignmentRejectedMarker}\nactor not allowed\n`);
        await writeFile(join(home, jobStartedPath), "1760572800123\n");
        expect(
          spawnSync(executable, args, {
            env: { ...process.env, HOME: home, USERPROFILE: home },
            encoding: "utf8",
          }).stdout,
        ).toBe(
          `${jobStartedMarker}\n1760572800123\n${assignmentRejectedMarker}\nactor not allowed\n`,
        );
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
}

test.each(["5", "6"])(
  "automatic cache writer fences workflow run %s before any job step",
  async (runId) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-cache-hook-"));
    try {
      await mkdir(join(home, "vectis-actions-runner/_vectis"), { recursive: true });
      const path = join(home, "job-started.sh");
      await writeFile(
        join(home, "policy"),
        renderRunnerPolicy({
          repositoryId: 2,
          actors: "any",
          approval: "automatic",
          cacheRun: { runId: 5, runAttempt: 1 },
        }),
      );
      await writeFile(path, bashJobStartedHook());
      const result = await runHook("bash", path, {
        ...process.env,
        HOME: home,
        ...env,
        GITHUB_RUN_ID: runId,
      });
      if (runId === "5") expect(result.status).toBe(0);
      else {
        expect(result.stdout).toContain(assignmentRejectedMarker);
        expect(await readFile(join(home, assignmentRejectedPath), "utf8")).toBe(
          "cache run mismatch\n",
        );
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
