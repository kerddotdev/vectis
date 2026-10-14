import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
