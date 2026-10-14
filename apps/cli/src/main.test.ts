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
