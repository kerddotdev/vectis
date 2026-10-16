import {
  defaultMaxRunners,
  VectisError,
  type Environment,
  type Snapshot,
  type RunnerCapacity,
  type Operation,
  type Instance,
} from "../../../packages/protocol/src/index.js";
import { RunnerProgress } from "../../../packages/protocol/src/runners.js";
import { Schema } from "effect";
import { estimatedVmMemoryMiB } from "../../../packages/runner/src/memory.js";
import { resourceProbe, type ResourceProbe } from "./resource-probe.js";

type Host = { cpus: number; memoryBytes: number };

function memoryBudget(snapshot: Snapshot, host: Host, probe: ResourceProbe) {
  const usage = probe(snapshot.instances);
  const hostMemoryMiB = host.memoryBytes / 1024 ** 2;
  let memoryCommittedMiB = 0;
  for (const instance of snapshot.instances) {
    if (instance.status === "stopped") continue;
    const environment = snapshot.environments.find((item) => item.id === instance.environmentId);
    const memoryMiB = instance.memoryMiB ?? environment?.memoryMiB ?? hostMemoryMiB;
    const floor = environment ? estimatedVmMemoryMiB({ os: environment.os, memoryMiB }) : memoryMiB;
    const measured = usage.footprintsMiB.get(instance.id);
    const footprint =
      measured !== undefined && Number.isFinite(measured) && measured >= 0
        ? measured
        : instance.status === "starting" && instance.pid === 0
          ? floor
          : memoryMiB;
    memoryCommittedMiB += Math.max(footprint, floor);
  }
  return {
    memoryBudgetMiB: snapshot.machine.memoryBudgetMiB ?? Math.floor(hostMemoryMiB * 0.75),
    memoryCommittedMiB,
    hostMemoryMiB,
    pressure: usage.pressure,
    pressureKnown: usage.pressureKnown,
  };
}

export function instanceAdmissionError(
  snapshot: Snapshot,
  environment: Environment,
  host: Host,
  count = 1,
  probe: ResourceProbe = resourceProbe,
): VectisError | undefined {
  const active = snapshot.instances.filter((instance) => instance.status !== "stopped");
  const budget = memoryBudget(snapshot, host, probe);
  let macos = environment.os === "macos" ? count : 0;
  for (const instance of active) {
    const defaults = snapshot.environments.find((item) => item.id === instance.environmentId);
    if (defaults?.os === "macos") macos++;
  }
  if (environment.cpu > host.cpus)
    return new VectisError("invalid_resources", "Requested VM CPUs exceed the host's core count.");
  if (budget.pressure !== "normal")
    return new VectisError(
      "memory_pressure",
      `Host memory pressure is ${budget.pressure}; new VMs cannot start.`,
      "Stop an idle VM or free host memory, then retry when memory pressure is normal.",
    );
  if (
    budget.memoryCommittedMiB + estimatedVmMemoryMiB(environment) * count >
    budget.memoryBudgetMiB
  )
    return new VectisError(
      "memory_budget_exceeded",
      "Starting this VM would exceed the shared VM memory budget.",
      "Stop an idle VM or increase the budget with vectis machine configure --memory-budget-mib <N>.",
    );
  if (environment.os === "macos" && macos > 2)
    return new VectisError("macos_limit", "The two-instance macOS limit has been reached.");
}

export function preparationBusy(snapshot: Snapshot) {
  return (
    snapshot.preparationBusy === true ||
    snapshot.operations.some(
      (operation) =>
        [
          "environment.provision",
          "environment.prepare-linux",
          "environment.resume",
          "environment.install-macos",
          "environment.install-windows",
          "environment.resume-windows",
          "environment.resume-macos",
          "environment.open-macos-setup",
        ].includes(operation.command) && ["accepted", "running"].includes(operation.status),
    )
  );
}

export function runnerCapacity(
  snapshot: Snapshot,
  host: Host,
  {
    lookup,
    probe = resourceProbe,
  }: {
    lookup?: {
      start(id: string): Operation | undefined;
      instance(id: string): Instance | undefined;
    };
    probe?: ResourceProbe;
  } = {},
): RunnerCapacity {
  const usage = probe(snapshot.instances);
  const measured: ResourceProbe = () => usage;
  const max = snapshot.machine.maxRunners ?? defaultMaxRunners;
  const runners = snapshot.operations
    .filter(
      (operation) =>
        operation.command === "runner.run" &&
        ["accepted", "running", "action_required"].includes(operation.status),
    )
    .map((operation) => {
      const progress = Schema.is(RunnerProgress)(operation.result) ? operation.result : undefined;
      const start =
        lookup?.start(operation.id) ??
        snapshot.operations.find((item) => item.key === `${operation.id}:start`);
      const instanceId = progress?.instanceId ?? start?.id;
      const instance =
        instanceId === undefined
          ? undefined
          : (lookup?.instance(instanceId) ??
            snapshot.instances.find((item) => item.id === instanceId));
      return { operation, progress, start, instance };
    })
    .filter(({ operation, progress, start, instance }) => {
      if (operation.status !== "action_required") return true;
      if (instance) return instance.status !== "stopped";
      // No start means no VM was created. Missing evidence after a start remains reserved.
      return (
        progress?.instanceId !== undefined ||
        (start !== undefined &&
          ["accepted", "running", "action_required", "succeeded"].includes(start.status))
      );
    });
  const active = runners.length;
  const ready = snapshot.environments.filter((item) => item.state === "ready");
  const reservations = runners.flatMap(({ operation, progress, instance }) => {
    if (instance) return [];
    const environmentId =
      progress?.environmentId ??
      snapshot.activities?.find(
        (activity) => activity.id === (operation.activityId ?? operation.id),
      )?.environmentId;
    const environment = ready.find((item) => item.id === environmentId);
    // Before binding resolution, reserve the largest startup estimate and a macOS slot.
    return [
      {
        id: operation.id,
        environmentId: environment?.id ?? ready.find((item) => item.os === "macos")?.id ?? "",
        cpu: environment?.cpu ?? Math.max(0, ...ready.map((item) => item.cpu)),
        memoryMiB: environment
          ? estimatedVmMemoryMiB(environment)
          : Math.max(0, ...ready.map(estimatedVmMemoryMiB)),
        status: "starting" as const,
        pid: 0,
        createdAt: operation.createdAt,
      },
    ];
  });
  const committed: Snapshot = { ...snapshot, instances: [...snapshot.instances, ...reservations] };
  const reserved = {
    ...committed,
    instances: committed.instances.filter(
      (instance) => !instance.role || !["starting", "running"].includes(instance.status),
    ),
  };
  const environments = ready.map((environment) => {
    let available = 0;
    if (!snapshot.machine.paused && !preparationBusy(snapshot)) {
      while (
        available < max - active &&
        !instanceAdmissionError(reserved, environment, host, available + 1, measured)
      )
        available++;
    }
    return { environmentId: environment.id, available };
  });
  return {
    max,
    active,
    available: Math.max(0, ...environments.map((item) => item.available)),
    environments,
    budget: memoryBudget(committed, host, measured),
  };
}
