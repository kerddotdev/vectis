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
