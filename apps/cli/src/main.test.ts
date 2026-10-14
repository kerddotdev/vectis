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
