vi.mock("../../server/src/resource-probe.js", () => ({
  resourceProbe: () => ({ footprintsMiB: new Map(), pressure: "normal", pressureKnown: true }),
}));

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { startService } from "../../server/src/http.js";
import type { JobLogRequest, JobLogs } from "../../../packages/protocol/src/jobs.js";
import { activityFor } from "../../server/src/activities.js";
import type { RunnerProgress } from "../../../packages/protocol/src/runners.js";

test("operation and activity inspection retain phases in pretty and compact JSON", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-cli-phases-"));
  const server = await startService({ home });
  const argv = process.argv;
  const exitCode = process.exitCode;
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    const command = { type: "runner.run", bindingId: "binding" } as const;
    const operation = server.store.accept(
      "runner",
      "runner",
      command.type,
      activityFor("runner", command),
      "runner",
    ).operation;
    const result: RunnerProgress = {
      bindingId: "binding",
      environmentId: "linux",
      leaseKey: operation.id,
      stage: "finished",
      phases: [{ name: "vm_start", startedAt: operation.createdAt, endedAt: operation.createdAt }],
    };
    server.store.update(operation, { status: "succeeded", result });
    for (const command of ["operation", "activity"]) {
      for (const flags of [[], ["--json"]]) {
        output.mockClear();
        vi.resetModules();
        process.argv = [
          process.execPath,
          "vectis",
          "--home",
          home,
          command,
          "get",
          "runner",
          ...flags,
        ];
        await import("./main.js");
        await vi.waitFor(() => expect(output).toHaveBeenCalledOnce());
        const printed: unknown = JSON.parse(String(output.mock.calls[0]?.[0]));
        expect(printed).toMatchObject(
          command === "operation"
            ? { result }
            : { operations: [expect.objectContaining({ result })] },
        );
      }
    }
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    output.mockRestore();
    vi.resetModules();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("machine configure settles without --wait and status prints runner capacity", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-cli-capacity-"));
  const server = await startService({ home });
  const argv = process.argv;
  const exitCode = process.exitCode;
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    process.argv = [
      process.execPath,
      "vectis",
      "--home",
      home,
      "machine",
      "configure",
      "--max-runners",
      "3",
      "--memory-budget-mib",
      "8192",
      "--key",
      "cli-configure",
      "--json",
    ];
    await import("./main.js");
    await vi.waitFor(() =>
      expect(output).toHaveBeenCalledWith(expect.stringContaining('"status":"succeeded"')),
    );
    expect(server.service.snapshot().machine).toMatchObject({
      maxRunners: 3,
      memoryBudgetMiB: 8192,
    });
    output.mockClear();
    vi.resetModules();
    process.argv = [process.execPath, "vectis", "--home", home, "status", "--json"];
    await import("./main.js");
    await vi.waitFor(() =>
      expect(output).toHaveBeenCalledWith(
        expect.stringContaining(
          '"runnerCapacity":{"max":3,"active":0,"available":0,"environments":[],',
        ),
      ),
    );
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    output.mockRestore();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test.each([
  { args: ["--memory-budget-mib", "2048"], valid: true },
  { args: ["--memory-budget-mib", "2047"], valid: false },
  { args: ["--memory-budget-mib", "4096.5"], valid: false },
  { args: ["--memory-budget-mib", "invalid"], valid: false },
  { args: [], valid: false },
])(
  "machine configure parses memory-only and rejects invalid arguments: $args",
  async ({ args, valid }) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-cli-budget-"));
    const server = await startService({ home });
    const submit = vi.spyOn(server.service, "submit");
    const argv = process.argv;
    const exitCode = process.exitCode;
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      vi.resetModules();
      process.argv = [
        process.execPath,
        "vectis",
        "--home",
        home,
        "machine",
        "configure",
        ...args,
        "--key",
        "budget",
        "--json",
      ];
      await import("./main.js");
      await vi.waitFor(() => expect(output).toHaveBeenCalled());
      if (valid) {
        expect(submit).toHaveBeenCalledWith("budget", {
          type: "machine.configure",
          memoryBudgetMiB: 2048,
        });
        expect(output).toHaveBeenCalledWith(expect.stringContaining('"status":"succeeded"'));
      } else {
        expect(submit).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
        expect(output).toHaveBeenCalledWith(expect.stringContaining('"error":'));
      }
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      output.mockRestore();
      submit.mockRestore();
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.each([
  { actors: "7,7,8", approval: "required", expected: { ids: [7, 8] } },
  { actors: "any", approval: "automatic", expected: "any" },
])(
  "repository access parses $actors as numeric user IDs and submits the shared command",
  async ({ actors, approval, expected }) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-cli-access-"));
    const server = await startService({ home });
    const submit = vi.spyOn(server.service, "submit");
    const argv = process.argv;
    const exitCode = process.exitCode;
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      vi.resetModules();
      process.argv = [
        process.execPath,
        "vectis",
        "--home",
        home,
        "repository",
        "access",
        "binding",
        "--actors",
        actors,
        "--approval",
        approval,
        "--key",
        "access",
        "--json",
      ];
      await import("./main.js");
      await vi.waitFor(() => expect(server.service.snapshot().operations).toHaveLength(1));
      const operation = server.service.snapshot().operations[0];
      expect(operation?.command).toBe("repository.access");
      if (!operation) throw new Error("Missing operation");
      expect(submit).toHaveBeenCalledWith("access", {
        type: "repository.access",
        bindingId: "binding",
        actors: expected,
        approval,
      });
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      output.mockRestore();
      submit.mockRestore();
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("repository readiness prints JSON for named repositories and binding inspections without submitting operations", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-cli-readiness-"));
  const server = await startService({ home });
  const argv = process.argv;
  const exitCode = process.exitCode;
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    for (const args of [
      ["owner/repo", "--environment", "linux"],
      ["--binding", "binding"],
    ]) {
      output.mockClear();
      vi.resetModules();
      process.argv = [
        process.execPath,
        "vectis",
        "--home",
        home,
        "repository",
        "readiness",
        ...args,
        "--json",
      ];
      await import("./main.js");
      await vi.waitFor(() =>
        expect(output).toHaveBeenCalledWith(expect.stringContaining('"ready":false')),
      );
      const value = output.mock.calls[0]?.[0];
      if (typeof value !== "string") throw new Error("Expected JSON output.");
      expect(JSON.parse(value)).toMatchObject({
        checks: expect.arrayContaining([
          expect.objectContaining({ code: "cloud_unconfigured", nextStep: expect.any(String) }),
        ]),
      });
    }
    expect(server.service.snapshot().operations).toEqual([]);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    output.mockRestore();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test.each([false, true])("job logs read every retained page, with follow=%s", async (follow) => {
  const home = await mkdtemp(join(tmpdir(), "vectis-cli-job-logs-"));
  const server = await startService({ home });
  const argv = process.argv;
  const exitCode = process.exitCode;
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const read = vi
    .spyOn(server.service, "jobLogs")
    .mockResolvedValueOnce({
      text: "first\n",
      next: 6,
      status: "in_progress",
      complete: false,
      truncated: false,
    })
    .mockResolvedValueOnce({
      text: "second\n",
      next: 13,
      status: "completed",
      complete: true,
      truncated: false,
    });
  const interrupts = process.listenerCount("SIGINT");
  try {
    vi.resetModules();
    process.argv = [
      process.execPath,
      "vectis",
      "--home",
      home,
      "job",
      "logs",
      "4",
      "--binding",
      "binding1",
      ...(follow ? ["--follow"] : []),
    ];
    await import("./main.js");
    await vi.waitFor(() => expect(output).toHaveBeenCalledWith("second\n"), { timeout: 6000 });
    expect(output).toHaveBeenCalledWith("first\n");
    expect(read.mock.calls.map(([input]) => input)).toEqual([
      { bindingId: "binding1", jobId: 4 },
      { bindingId: "binding1", jobId: 4, after: 6 },
    ]);
    expect(process.listenerCount("SIGINT")).toBe(interrupts);
    expect(server.service.snapshot().operations).toHaveLength(0);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    output.mockRestore();
    read.mockRestore();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("job log follow stops on interrupt and releases its polling timer and listeners", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-cli-follow-"));
  const server = await startService({ home });
  const argv = process.argv;
  const exitCode = process.exitCode;
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const read = vi.spyOn(server.service, "jobLogs").mockResolvedValue({
    text: "waiting",
    next: 7,
    status: "in_progress",
    complete: false,
    truncated: false,
  });
  const interrupts = process.listenerCount("SIGINT");
  try {
    vi.resetModules();
    process.argv = [
      process.execPath,
      "vectis",
      "--home",
      home,
      "job",
      "logs",
      "4",
      "--binding",
      "binding1",
      "--follow",
    ];
    await import("./main.js");
    await vi.waitFor(() => expect(output).toHaveBeenCalledWith("waiting"));
    process.emit("SIGINT");
    await vi.waitFor(() => expect(process.listenerCount("SIGINT")).toBe(interrupts));
    expect(read).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(exitCode);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    output.mockRestore();
    read.mockRestore();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "job log follow backs off empty chunks and resets on text, json=%s",
  async (json) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-cli-backoff-"));
    const argv = process.argv;
    const exitCode = process.exitCode;
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const empty: JobLogs = {
      text: "",
      next: 0,
      status: "in_progress",
      complete: false,
      truncated: false,
    };
    const read = vi
      .fn<(input: JobLogRequest, signal?: AbortSignal) => Promise<JobLogs>>()
      .mockResolvedValue(empty);
    for (let index = 0; index < 6; index++) read.mockResolvedValueOnce(empty);
    read.mockResolvedValueOnce({ ...empty, text: "new output", next: 10 });
    read.mockResolvedValueOnce({ ...empty, next: 10 });
    read.mockResolvedValueOnce({ ...empty, next: 10, status: "completed", complete: true });
    const interrupts = process.listenerCount("SIGINT");
    const terminations = process.listenerCount("SIGTERM");
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.doMock("../../../packages/client/src/local.js", () => ({
      localClient: async (selectedHome: string) => {
        expect(selectedHome).toBe(home);
        return { jobLogs: read };
      },
    }));
    vi.doMock("node:timers/promises", () => ({
      setTimeout: (milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    }));
    try {
      process.argv = [
        process.execPath,
        "vectis",
        "--home",
        home,
        "job",
        "logs",
        "4",
        "--binding",
        "binding1",
        "--follow",
        ...(json ? ["--json"] : []),
      ];
      await import("./main.js");
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledOnce();
      const delays = [2000, 4000, 8000, 16000, 30000, 30000, 2000, 2000];
      for (const [index, delay] of delays.entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(read).toHaveBeenCalledTimes(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(index + 2);
      }
      expect(read.mock.calls.map(([input]) => input)).toEqual([
        { bindingId: "binding1", jobId: 4 },
        ...Array.from({ length: 6 }, () => ({ bindingId: "binding1", jobId: 4, after: 0 })),
        ...Array.from({ length: 2 }, () => ({ bindingId: "binding1", jobId: 4, after: 10 })),
      ]);
      expect(output).toHaveBeenCalledWith(
        json ? expect.stringContaining('"text":"new output"') : "new output",
      );
      expect(process.listenerCount("SIGINT")).toBe(interrupts);
      expect(process.listenerCount("SIGTERM")).toBe(terminations);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60000);
      expect(read).toHaveBeenCalledTimes(9);
      expect(process.exitCode).toBe(exitCode);
    } finally {
      if (process.listenerCount("SIGINT") > interrupts) process.emit("SIGINT");
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.doUnmock("node:timers/promises");
      vi.doUnmock("../../../packages/client/src/local.js");
      vi.resetModules();
      process.argv = argv;
      process.exitCode = exitCode;
      output.mockRestore();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.each(["rosetta", "off"])(
  "environment configure parses --x64 %s through the shared command",
  async (x64) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-cli-x64-"));
    const server = await startService({ home });
    const submit = vi.spyOn(server.service, "submit");
    const argv = process.argv;
    const exitCode = process.exitCode;
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      vi.resetModules();
      process.argv = [
        process.execPath,
        "vectis",
        "--home",
        home,
        "environment",
        "configure",
        "linux",
        "--x64",
        x64,
        "--key",
        "x64",
        "--json",
      ];
      await import("./main.js");
      await vi.waitFor(() =>
        expect(submit).toHaveBeenCalledWith("x64", {
          type: "environment.configure",
          id: "linux",
          x64,
        }),
      );
      await vi.waitFor(() => expect(output).toHaveBeenCalled());
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      output.mockRestore();
      submit.mockRestore();
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.each([
  { subcommand: "configure", egress: "internet_only" },
  { subcommand: "configure", egress: "open" },
  { subcommand: "configure", egress: "invalid" },
  { subcommand: "start", egress: "internet_only" },
])(
  "environment $subcommand validates --egress $egress and lists effective state",
  async ({ subcommand, egress }) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-cli-egress-"));
    const server = await startService({ home });
    const submit = vi.spyOn(server.service, "submit");
    const argv = process.argv;
    const exitCode = process.exitCode;
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const basePath = join(home, "base.img");
      await writeFile(basePath, "synthetic image");
      server.store.put("environment", "windows", {
        id: "windows",
        name: "Windows",
        os: "windows",
        state: "ready",
        cpu: 1,
        memoryMiB: 512,
        basePath,
      });
      vi.resetModules();
      process.argv = [
        process.execPath,
        "vectis",
        "--home",
        home,
        "environment",
        subcommand,
        "windows",
        "--egress",
        egress,
        "--key",
        "egress",
        "--json",
      ];
      await import("./main.js");
      await vi.waitFor(() => expect(output).toHaveBeenCalled());
      if (egress === "invalid" || subcommand === "start") {
        expect(submit).not.toHaveBeenCalled();
        expect(output).toHaveBeenCalledWith(
          expect.stringContaining(
            `"code":"${subcommand === "start" ? "invalid_arguments" : "invalid_request"}"`,
          ),
        );
        return;
      }
      expect(submit).toHaveBeenCalledWith("egress", {
        type: "environment.configure",
        id: "windows",
        egress,
      });
      expect(output).toHaveBeenCalledWith(expect.stringContaining('"status":"succeeded"'));
      for (const commands of [["status"], ["environment", "list"]]) {
        output.mockClear();
        vi.resetModules();
        process.argv = [process.execPath, "vectis", "--home", home, ...commands, "--json"];
        await import("./main.js");
        await vi.waitFor(() =>
          expect(output).toHaveBeenCalledWith(
            expect.stringContaining(
              `"network":{"egress":"${egress}","enforcement":"${egress === "open" ? "not_enforced" : "enforced"}"}`,
            ),
          ),
        );
      }
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      output.mockRestore();
      submit.mockRestore();
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

const runCommands = [
  {
    args: ["run", "rerun-failed", "binding", "42"],
    command: { type: "run.rerun-failed", bindingId: "binding", runId: 42 },
  },
  {
    args: ["run", "cancel", "binding", "42"],
    command: { type: "run.cancel", bindingId: "binding", runId: 42 },
  },
  {
    args: [
      "workflow",
      "dispatch",
      "binding",
      "ci.yml",
      "--ref",
      "main",
      "--input",
      "target=staging",
      "--input",
      "version=a=b",
      "--input",
      "empty=",
    ],
    command: {
      type: "workflow.dispatch",
      bindingId: "binding",
      workflow: "ci.yml",
      ref: "main",
      inputs: { target: "staging", version: "a=b", empty: "" },
    },
  },
  {
    args: ["workflow", "dispatch", "binding", "12", "--ref", "v1"],
    command: { type: "workflow.dispatch", bindingId: "binding", workflow: 12, ref: "v1" },
  },
];
test.each(runCommands)(
  "CLI parses $args and waits when --wait is supplied",
  async ({ args, command }) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-cli-runs-"));
    const server = await startService({ home });
    const submit = vi.spyOn(server.service, "submit");
    const argv = process.argv;
    const exitCode = process.exitCode;
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      vi.resetModules();
      process.argv = [
        process.execPath,
        "vectis",
        "--home",
        home,
        ...args,
        "--key",
        "cli-run",
        "--wait",
        "--json",
      ];
      await import("./main.js");
      await vi.waitFor(() =>
        expect(output).toHaveBeenCalledWith(expect.stringContaining('"status":"failed"')),
      );
      expect(submit).toHaveBeenCalledWith("cli-run", command);
      expect(process.exitCode).toBe(1);
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      output.mockRestore();
      submit.mockRestore();
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.each([
  ["workflow", "dispatch", "binding", "ci.yml"],
  [
    "workflow",
    "dispatch",
    "binding",
    "ci.yml",
    "--ref",
    "main",
    "--input",
    "target=one",
    "--input",
    "target=two",
  ],
  ["workflow", "dispatch", "binding", "ci.yml", "--ref", "main", "--input", "missing-equals"],
  ["run", "cancel", "binding", "-1"],
])("CLI refuses malformed run control arguments %s before submission", async (...args) => {
  const home = await mkdtemp(join(tmpdir(), "vectis-cli-invalid-runs-"));
  const server = await startService({ home });
  const submit = vi.spyOn(server.service, "submit");
  const argv = process.argv;
  const exitCode = process.exitCode;
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    vi.resetModules();
    process.argv = [process.execPath, "vectis", "--home", home, ...args, "--json"];
    await import("./main.js");
    await vi.waitFor(() =>
      expect(output).toHaveBeenCalledWith(expect.stringContaining('"error":')),
    );
    expect(submit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    output.mockRestore();
    submit.mockRestore();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test.each([
  { value: "0", valid: true },
  { value: "1", valid: true },
  { value: "4", valid: true },
  { value: "-1", valid: false },
  { value: "5", valid: false },
  { value: "1.5", valid: false },
  { value: "invalid", valid: false },
])(
  "environment configure parses --warm-pool $value through the shared command",
  async ({ value, valid }) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-cli-warm-"));
    const server = await startService({ home });
    const submit = vi.spyOn(server.service, "submit");
    const argv = process.argv;
    const exitCode = process.exitCode;
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      vi.resetModules();
      process.argv = [
        process.execPath,
        "vectis",
        "--home",
        home,
        "environment",
        "configure",
        "linux",
        "--warm-pool",
        value,
        "--key",
        "pool",
        "--json",
      ];
      await import("./main.js");
      await vi.waitFor(() => expect(output).toHaveBeenCalled());
      if (valid)
        expect(submit).toHaveBeenCalledWith("pool", {
          type: "environment.configure",
          id: "linux",
          warmPool: Number(value),
        });
      else {
        expect(submit).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
      }
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      output.mockRestore();
      submit.mockRestore();
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("CLI status shows warm pool VMs without counting them as running jobs", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-cli-warm-status-"));
  const server = await startService({ home });
  const argv = process.argv;
  const exitCode = process.exitCode;
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    server.service.store.put("environment", "linux", {
      id: "linux",
      name: "Linux",
      os: "linux",
      state: "ready",
      basePath: join(home, "base"),
      cpu: 1,
      memoryMiB: 512,
      warmPool: 1,
    });
    server.service.store.put("instance", "warm", {
      id: "warm",
      environmentId: "linux",
      status: "running",
      role: "warm",
      memoryMiB: 512,
      pid: 0,
      createdAt: new Date().toISOString(),
    });
    vi.resetModules();
    process.argv = [process.execPath, "vectis", "--home", home, "status", "--json"];
    await import("./main.js");
    await vi.waitFor(() =>
      expect(output).toHaveBeenCalledWith(expect.stringContaining('"role":"warm"')),
    );
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"active":0'));
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    output.mockRestore();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test.each([
  {
    action: "enable",
    extra: ["--size-gib", "30"],
    expected: { type: "repository.cache", bindingId: "binding", enabled: true, sizeGiB: 30 },
  },
  {
    action: "disable",
    extra: [],
    expected: { type: "repository.cache", bindingId: "binding", enabled: false },
  },
  { action: "clear", extra: [], expected: { type: "cache.clear", bindingId: "binding" } },
])("repository cache $action submits the shared command", async ({ action, extra, expected }) => {
  const home = await mkdtemp(join(tmpdir(), "vectis-cli-cache-"));
  const server = await startService({ home });
  const submit = vi.spyOn(server.service, "submit");
  const argv = process.argv;
  const exitCode = process.exitCode;
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    vi.resetModules();
    process.argv = [
      process.execPath,
      "vectis",
      "--home",
      home,
      "repository",
      "cache",
      action,
      "binding",
      ...extra,
      "--key",
      "cache",
      "--json",
    ];
    await import("./main.js");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith("cache", expected));
    await vi.waitFor(() =>
      expect(output).toHaveBeenCalledWith(expect.stringContaining('"status":"failed"')),
    );
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    output.mockRestore();
    submit.mockRestore();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test.each([
  { input: "demand", mode: "demand" },
  { input: "scale-set", mode: "scale_set" },
  { input: "scale_set", mode: undefined },
  { input: "unknown", mode: undefined },
])(
  "repository capacity-mode parses $input and waits for the shared setting",
  async ({ input, mode }) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-cli-mode-"));
    const server = await startService({ home });
    const submit = vi.spyOn(server.service, "submit");
    const argv = process.argv;
    const exitCode = process.exitCode;
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      vi.resetModules();
      process.argv = [
        process.execPath,
        "vectis",
        "--home",
        home,
        "repository",
        "capacity-mode",
        "binding",
        input,
        "--key",
        "capacity-mode",
        "--json",
      ];
      await import("./main.js");
      if (mode === undefined) {
        await vi.waitFor(() =>
          expect(output).toHaveBeenCalledWith(expect.stringContaining("invalid_capacity_mode")),
        );
        expect(submit).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() =>
          expect(output).toHaveBeenCalledWith(expect.stringContaining('"status":"failed"')),
        );
        expect(submit).toHaveBeenCalledWith("capacity-mode", {
          type: "repository.capacity-mode",
          bindingId: "binding",
          mode,
        });
        expect(server.service.snapshot().operations[0]?.status).toBe("failed");
        expect(process.exitCode).toBe(1);
      }
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      output.mockRestore();
      submit.mockRestore();
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
