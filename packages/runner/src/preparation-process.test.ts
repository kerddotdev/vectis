import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import {
  preparationStopped,
  runPreparationGuest,
  runPreparationProcess,
} from "./preparation-process.js";
async function fixture(body: string, run: (helper: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "vectis-prepare-process-"));
  const helper = join(directory, "helper");
  await writeFile(helper, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  try {
    await run(helper, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test("successful preparation requires a marker and observed process exit", () =>
  fixture('process.stderr.write("VECTIS_READY\\n");', async (helper, directory) => {
    await runPreparationGuest(
      { helper, directory, id: "setup", cpu: 2, memoryMiB: 2048, marker: "VECTIS_READY" },
      new AbortController().signal,
    );
    expect(await preparationStopped(directory, "setup")).toBe(true);
    expect(await preparationStopped(directory, "other")).toBe(false);
  }));
test("cancellation closes the owned guest and retains a verifiable exit receipt", () =>
  fixture(
    'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));',
    async (helper, directory) => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 50);
      try {
        await expect(
          runPreparationGuest(
            { helper, directory, id: "setup", cpu: 2, memoryMiB: 2048, marker: "VECTIS_READY" },
            abort.signal,
          ),
        ).rejects.toThrow();
      } finally {
        clearTimeout(timer);
      }
      expect(await preparationStopped(directory, "setup")).toBe(true);
      expect((await stat(join(directory, "preparation.log"))).mode & 0o777).toBe(0o600);
    },
  ));
test("a clean process exit without completed guest setup is not success", () =>
  fixture("process.exit(0);", async (helper, directory) => {
    await expect(
      runPreparationGuest(
        { helper, directory, id: "setup", cpu: 2, memoryMiB: 2048, marker: "VECTIS_READY" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "guest_preparation_failed" });
  }));

test("installer completion is observed on stdout without trusting exit zero alone", () =>
  fixture(
    'process.stdout.write(JSON.stringify({event:"installation.action_required"}));',
    async (helper, directory) => {
      await runPreparationProcess(
        {
          helper,
          directory,
          id: "install",
          args: ["install-macos"],
          marker: '"installation.action_required"',
          markerStream: "stdout",
        },
        new AbortController().signal,
      );
      expect(await preparationStopped(directory, "install")).toBe(true);
    },
  ));

test("setup observes only complete validated guest network events", () =>
  fixture(
    'process.stdout.write(\'noise\\n{"event":"vm.running","macAddress":"bad"}\\n{"event":"vm.running",\');setTimeout(()=>process.stdout.write(\'"macAddress":"02:11:22:33:44:55"}\\n\'),10);',
    async (helper, directory) => {
      const addresses: string[] = [];
      await runPreparationProcess(
        {
          helper,
          directory,
          id: "network",
          args: [],
          marker: '"vm.running"',
          markerStream: "stdout",
          onRunning: (address) => {
            addresses.push(address);
          },
        },
        new AbortController().signal,
      );
      expect(addresses).toEqual(["02:11:22:33:44:55"]);
    },
  ));

test("failure to persist a setup event closes its owned process", () =>
  fixture(
    'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));process.stdout.write(\'{"event":"vm.running","macAddress":"02:11:22:33:44:55"}\\n\');',
    async (helper, directory) => {
      await expect(
        runPreparationProcess(
          {
            helper,
            directory,
            id: "failed-network",
            args: [],
            marker: '"vm.running"',
            markerStream: "stdout",
            onRunning: () => {
              throw new Error("State cannot be persisted");
            },
          },
          AbortSignal.timeout(3000),
        ),
      ).rejects.toMatchObject({ code: "guest_preparation_failed" });
      expect(await preparationStopped(directory, "failed-network")).toBe(true);
    },
  ));
