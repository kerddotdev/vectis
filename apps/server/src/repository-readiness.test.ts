import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { VectisError } from "../../../packages/protocol/src/index.js";
import type { CloudRepositoryReadiness } from "../../../packages/protocol/src/readiness.js";
import { startService } from "./http.js";
import { VectisClient } from "../../../packages/client/src/index.js";
import { recordCacheGuestPrivilege } from "./cache-guest-privilege.js";

const cloud: CloudRepositoryReadiness = {
  environmentId: "linux",
  checks: [
    { id: "github.account", status: "ok", message: "Linked." },
    { id: "github.app", status: "ok", message: "Accessible." },
    { id: "github.admin", status: "ok", message: "Admin." },
    { id: "github.approval", status: "ok", message: "Private." },
    {
      id: "repository.binding",
      status: "attention",
      code: "automatic_disabled",
      message: "Automatic runners are disabled.",
      nextStep: "Enable automatic runners.",
    },
  ],
};

test("cache readiness reports persistent attention only for an enabled cache on the probed image", async () => {
  const { server, close } = await fixture();
  try {
    const environment = server.store.snapshot().environments[0];
    if (!environment) throw new Error("Missing synthetic environment");
    const readCloud = async () => ({ ...cloud, cacheVolumeEnabled: true });
    const readiness = () => server.service.repositoryReadiness({ bindingId: "binding" }, readCloud);
    expect(
      (await readiness()).checks.find((check) => check.id === "cache.guest_sudo")?.status,
    ).toBe("unknown");
    recordCacheGuestPrivilege(server.store, environment, false);
    expect((await readiness()).checks).toContainEqual(
      expect.objectContaining({
        id: "cache.guest_sudo",
        status: "attention",
        code: "cache_volume_requires_guest_sudo",
        nextStep: expect.any(String),
      }),
    );
    const disabled = await server.service.repositoryReadiness(
      { bindingId: "binding" },
      async () => ({ ...cloud, cacheVolumeEnabled: false }),
    );
    expect(disabled.checks.some((check) => check.id === "cache.guest_sudo")).toBe(false);
    recordCacheGuestPrivilege(server.store, environment, true);
    expect(
      (await readiness()).checks.find((check) => check.id === "cache.guest_sudo")?.status,
    ).toBe("ok");
    server.store.put("environment", environment.id, {
      ...environment,
      image: { revision: "replacement", provisionedAt: "now" },
    });
    expect(
      (await readiness()).checks.find((check) => check.id === "cache.guest_sudo")?.status,
    ).toBe("unknown");
  } finally {
    await close();
  }
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "vectis-readiness-"));
  const server = await startService({ home });
  server.store.put("environment", "linux", {
    id: "linux",
    name: "Linux",
    os: "linux",
    state: "ready",
    basePath: join(home, "unused.img"),
    cpu: 1,
    memoryMiB: 512,
  });
  return {
    server,
    client: new VectisClient(server.connection),
    close: async () => {
      await server.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("readiness reads the local environment independently when cloud pairing is missing", async () => {
  const { server, client, close } = await fixture();
  try {
    const revision = server.store.snapshot().revision;
    const report = await client.repositoryReadiness({
      repositoryName: "owner/repo",
      environmentId: "linux",
    });
    expect(report.ready).toBe(false);
    expect(report.checks[0]).toMatchObject({
      id: "cloud",
      status: "blocked",
      code: "cloud_unconfigured",
      nextStep: expect.any(String),
    });
    expect(report.checks.find((check) => check.id === "environment")).toMatchObject({
      status: "ok",
    });
    expect(report.checks.find((check) => check.id === "github.app")).toMatchObject({
      status: "unknown",
    });
    expect(server.store.snapshot().revision).toBe(revision);
    expect(server.store.snapshot().operations).toEqual([]);
    const binding = await client.repositoryReadiness({ bindingId: "binding" });
    expect(binding.checks.find((check) => check.id === "environment")).toMatchObject({
      status: "unknown",
    });
  } finally {
    await close();
  }
});

test("readiness uses the service environment state and does not treat attention as blocked", async () => {
  const { server, close } = await fixture();
  try {
    const readCloud = vi.fn(async () => cloud);
    const ready = await server.service.repositoryReadiness({ bindingId: "binding" }, readCloud);
    expect(ready.ready).toBe(true);
    expect(ready.checks.map((check) => check.id)).toEqual([
      "cloud",
      "github.account",
      "github.app",
      "github.admin",
      "github.approval",
      "environment",
      "repository.binding",
    ]);
    const missing = await server.service.repositoryReadiness(
      { repositoryName: "owner/repo", environmentId: "missing" },
      readCloud,
    );
    expect(missing.ready).toBe(false);
    expect(missing.checks.find((check) => check.id === "environment")).toMatchObject({
      status: "blocked",
      code: "environment_unavailable",
      target: { area: "environments", section: "missing" },
      nextStep: expect.any(String),
    });
    const environment = server.store.snapshot().environments[0];
    if (!environment) throw new Error("Missing synthetic environment.");
    server.store.put("environment", "linux", { ...environment, state: "action_required" });
    const setup = await server.service.repositoryReadiness({ bindingId: "binding" }, readCloud);
    expect(setup.ready).toBe(false);
    expect(setup.checks.find((check) => check.id === "environment")).toMatchObject({
      code: "setup_required",
    });
    expect((await new VectisClient(server.connection).doctor()).checks).toContainEqual(
      expect.objectContaining({ id: "runtime.qemu", status: "attention" }),
    );
  } finally {
    await close();
  }
});

test("cloud outages produce unknown dependent checks while local environment problems stay actionable", async () => {
  const { server, close } = await fixture();
  try {
    const report = await server.service.repositoryReadiness(
      { repositoryName: "owner/repo", environmentId: "missing" },
      async () => {
        throw new VectisError("cloud_unavailable", "Offline.", "Check the connection.");
      },
    );
    expect(report.ready).toBe(false);
    expect(report.checks[0]).toMatchObject({ status: "unknown", code: "cloud_unavailable" });
    expect(report.checks.find((check) => check.id === "environment")).toMatchObject({
      status: "blocked",
      code: "environment_unavailable",
    });
    expect(report.checks.at(-1)).toMatchObject({ id: "repository.binding", status: "unknown" });
  } finally {
    await close();
  }
});

test("readiness preserves a rejected binding as an authorization failure", async () => {
  const { server, close } = await fixture();
  try {
    const rejected = new VectisError(
      "repository_access_denied",
      "Another owner's binding.",
      "Select your own binding.",
    );
    await expect(
      server.service.repositoryReadiness({ bindingId: "foreign" }, async () => {
        throw rejected;
      }),
    ).rejects.toBe(rejected);
    expect(server.store.snapshot().operations).toEqual([]);
  } finally {
    await close();
  }
});
