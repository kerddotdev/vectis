import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Schema } from "effect";
import { Environment, Snapshot, type Egress } from "../../../packages/protocol/src/index.js";
import { VmRuntime } from "../../../packages/runner/src/runtime.js";
import { Service } from "./service.js";
import { Store } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture(os: Environment["os"], egress?: Egress) {
  const home = await mkdtemp(join(tmpdir(), "vectis-egress-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const store = new Store(":memory:");
  cleanups.push(async () => store.close());
  const service = new Service(store, new VmRuntime({ home }));
  cleanups.push(() => service.close());
  const basePath = join(home, "base");
  if (os === "macos") await mkdir(basePath);
  else await writeFile(basePath, "synthetic image");
  const environment: Environment = {
    id: os,
    name: os,
    os,
    state: "ready",
    basePath,
    cpu: 1,
    memoryMiB: 512,
    ...(egress === undefined ? {} : { egress }),
  };
  store.put("environment", environment.id, environment);
  return { service, store, environment };
}

test.each(["linux", "macos", "windows"] as const)(
  "%s validates egress configuration without changing existing instances",
  async (os) => {
    const { service, store, environment } = await fixture(os);
    const instance = {
      id: "running",
      environmentId: os,
      directory: join(environment.basePath, "instance"),
      cpu: 1,
      memoryMiB: 512,
      status: "running",
      pid: 0,
      createdAt: new Date().toISOString(),
    };
    store.put("instance", instance.id, instance);
    for (const egress of ["open", "internet_only", "open"] as const) {
      const before = store.get("environment", os);
      const operation = service.submit(`configure-${egress}-${service.snapshot().revision}`, {
        type: "environment.configure",
        id: os,
        egress,
      });
      await service.drain();
      const completed = service.snapshot().operations.find((item) => item.id === operation.id);
      if (os !== "windows" && egress === "internet_only") {
        expect(completed).toMatchObject({
          status: "failed",
          message:
            "Apple Virtualization NAT cannot restrict guest network access yet; this environment can reach the host and local network.",
          result: { code: "egress_unsupported" },
        });
        expect(store.get("environment", os)).toEqual(before);
      } else {
        expect(completed).toMatchObject({
          status: "succeeded",
          result: { environment: { egress }, appliesTo: "future_instances" },
        });
        expect(store.get("environment", os)).toEqual({ ...environment, egress });
      }
      expect(store.get("instance", instance.id)).toEqual(instance);
    }
  },
);

test.each([
  { os: "windows", egress: undefined, effective: "internet_only", enforcement: "enforced" },
  { os: "windows", egress: "internet_only", effective: "internet_only", enforcement: "enforced" },
  { os: "windows", egress: "open", effective: "open", enforcement: "not_enforced" },
  { os: "linux", egress: undefined, effective: "open", enforcement: "not_enforced" },
  { os: "macos", egress: undefined, effective: "open", enforcement: "not_enforced" },
  { os: "linux", egress: "open", effective: "open", enforcement: "not_enforced" },
  { os: "macos", egress: "open", effective: "open", enforcement: "not_enforced" },
  { os: "linux", egress: "internet_only", effective: "open", enforcement: "not_enforced" },
  { os: "macos", egress: "internet_only", effective: "open", enforcement: "not_enforced" },
] as const)("$os with $egress reports $effective / $enforcement", async (input) => {
  const { service, store, environment } = await fixture(input.os, input.egress);
  const snapshot = Schema.decodeUnknownSync(Snapshot)(service.snapshot());
  expect(snapshot.environments[0]?.network).toEqual({
    egress: input.effective,
    enforcement: input.enforcement,
  });
  expect(store.get("environment", environment.id)).toEqual(environment);
});

test.each(["linux", "macos"] as const)(
  "%s registration and startup cannot bypass unsupported egress validation",
  async (os) => {
    const { service, store, environment } = await fixture(os, "internet_only");
    for (const command of [
      { type: "environment.register", environment: { ...environment, id: "new" } },
      { type: "environment.start", id: os },
    ] as const) {
      const operation = service.submit(command.type, command);
      await service.drain();
      expect(service.snapshot().operations.find((item) => item.id === operation.id)).toMatchObject({
        status: "failed",
        result: { code: "egress_unsupported" },
      });
    }
    expect(store.get("environment", "new")).toBeUndefined();
    expect(service.snapshot().instances).toEqual([]);
  },
);
