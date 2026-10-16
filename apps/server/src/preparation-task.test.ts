import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import type { LinuxPreparation } from "../../../packages/protocol/src/index.js";
import {
  prepareLinux,
  preparationDirectory,
} from "../../../packages/runner/src/linux-preparation.js";
import { runPreparationGuest } from "../../../packages/runner/src/preparation-process.js";

vi.mock("../../../packages/runner/src/linux-preparation.js", async (original) => ({
  ...(await original<typeof import("../../../packages/runner/src/linux-preparation.js")>()),
  prepareLinux: vi.fn(),
  validatePreparation: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
const configuration: LinuxPreparation = {
  id: "linux",
  name: "Linux",
  imageDirectory: "/isolated/images",
  storagePath: "/isolated/vms",
  cpu: 2,
  memoryMiB: 2048,
  diskGiB: 32,
};
test("preparation cannot overlap an existing VM reservation", async () => {
  const store = new Store(":memory:");
  const service = new Service(store, new VmRuntime({ home: "/unused-isolated-home" }));
  store.put("instance", "running", {
    id: "running",
    environmentId: "other",
    directory: "/isolated/instance",
    cpu: 2,
    memoryMiB: 2048,
    status: "running",
    pid: 0,
    createdAt: new Date().toISOString(),
  });
  try {
    const op = service.submit("prepare", { type: "environment.prepare-linux", ...configuration });
    await service.drain();
    expect(store.snapshot().operations.find((item) => item.id === op.id)?.result).toMatchObject({
      code: "preparation_busy",
    });
    expect(store.list("preparation")).toHaveLength(0);
  } finally {
    await service.close();
    store.close();
  }
});
test("resuming completed preparation cannot overwrite registered settings", async () => {
  const store = new Store(":memory:");
  const service = new Service(store, new VmRuntime({ home: "/unused-isolated-home" }));
  store.put("preparation", "setup", { id: "setup", configuration, phase: "prepared" });
  store.put("environment", "linux", {
    id: "linux",
    name: "Changed",
    os: "linux",
    basePath: "/isolated/base",
    cpu: 4,
    memoryMiB: 8192,
    state: "ready",
  });
  try {
    const op = service.submit("resume", { type: "environment.resume", id: "setup" });
    await service.drain();
    expect(store.snapshot().operations.find((item) => item.id === op.id)?.result).toMatchObject({
      code: "preparation_complete",
    });
    expect(store.snapshot().environments[0]?.cpu).toBe(4);
  } finally {
    await service.close();
    store.close();
  }
});

test.each(["failure marker", "timeout"] as const)(
  "Linux preparation exposes serial diagnostics in the operation after %s",
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-preparation-task-"));
    const store = new Store(join(home, "state.sqlite"));
    const service = new Service(store, new VmRuntime({ home }));
    const originalTimeout = AbortSignal.timeout;
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      originalTimeout(ms === 3600000 ? 1000 : ms),
    );
    vi.mocked(prepareLinux).mockImplementation(async (preparation, _options, signal, progress) => {
      const directory = preparationDirectory(preparation);
      await mkdir(directory, { recursive: true });
      const helper = join(home, "synthetic-helper");
      await writeFile(
        helper,
        `#!${process.execPath}
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stderr.write("token=ServiceCanary123456789\\nvectis-provision: dependencies-install\\n");
${mode === "failure marker" ? 'process.stderr.write("VECTIS_PREPARATION_FAILED_setup step=runner-dependencies exit=23\\n");' : ""}
`,
        { mode: 0o700 },
      );
      progress("booting");
      try {
        await runPreparationGuest(
          {
            helper,
            directory,
            id: preparation.id,
            cpu: 2,
            memoryMiB: 2048,
            marker: "VECTIS_READY",
            failureMarker: "VECTIS_PREPARATION_FAILED_setup",
          },
          signal,
        );
      } catch (error) {
        progress("interrupted");
        throw error;
      }
      throw new Error("Synthetic preparation must fail");
    });
    try {
      const op = service.submit("prepare", {
        type: "environment.prepare-linux",
        ...configuration,
        imageDirectory: home,
        storagePath: home,
      });
      await service.drain();
      await vi.waitFor(
        () => {
          expect(store.snapshot().operations.find((item) => item.id === op.id)?.status).toBe(
            "action_required",
          );
        },
        { timeout: 3000 },
      );
      const result = store.snapshot().operations.find((item) => item.id === op.id);
      expect(result).toMatchObject({
        status: "action_required",
        result: {
          phase: "interrupted",
          code: mode === "timeout" ? "preparation_timeout" : "guest_preparation_failed",
          diagnostics: expect.stringContaining(
            "token=[redacted]\nvectis-provision: dependencies-install",
          ),
        },
      });
      expect(JSON.stringify(result)).not.toContain("ServiceCanary");
      expect(store.snapshot().environments).toHaveLength(0);
    } finally {
      await service.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
