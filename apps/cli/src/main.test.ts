import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { startService } from "../../server/src/http.js";

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
      "--key",
      "cli-configure",
      "--json",
    ];
    await import("./main.js");
    await vi.waitFor(() =>
      expect(output).toHaveBeenCalledWith(expect.stringContaining('"status":"succeeded"')),
    );
    expect(server.service.snapshot().machine.maxRunners).toBe(3);
    output.mockClear();
    vi.resetModules();
    process.argv = [process.execPath, "vectis", "--home", home, "status", "--json"];
    await import("./main.js");
    await vi.waitFor(() =>
      expect(output).toHaveBeenCalledWith(
        expect.stringContaining('"runnerCapacity":{"max":3,"active":0,"available":0}'),
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
