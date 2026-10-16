import {
  defaultMaxRunners,
  VectisError,
  type Environment,
  type Snapshot,
  type RunnerCapacity,
} from "../../../packages/protocol/src/index.js";
import { RunnerProgress } from "../../../packages/protocol/src/runners.js";
import { Schema } from "effect";

type Host = { cpus: number; memoryBytes: number };

export function instanceAdmissionError(
  snapshot: Snapshot,
  environment: Environment,
  host: Host,
  count = 1,
): VectisError | undefined {
  const active = snapshot.instances.filter((instance) => instance.status !== "stopped");
  let cpu = environment.cpu * count;
  let memory = environment.memoryMiB * count;
  let macos = environment.os === "macos" ? count : 0;
  for (const instance of active) {
    const defaults = snapshot.environments.find((item) => item.id === instance.environmentId);
    cpu += instance.cpu ?? defaults?.cpu ?? 0;
    memory += instance.memoryMiB ?? defaults?.memoryMiB ?? 0;
    if (defaults?.os === "macos") macos++;
  }
  if (cpu > host.cpus)
    return new VectisError("capacity_exceeded", "Requested VM CPUs exceed the host budget.");
  if (memory * 1024 * 1024 > host.memoryBytes * 0.75)
    return new VectisError("capacity_exceeded", "Requested VM memory exceeds the host budget.");
  if (environment.os === "macos" && macos > 2)
    return new VectisError("macos_limit", "The two-instance macOS limit has been reached.");
}

export function runnerCapacity(snapshot: Snapshot, host: Host): RunnerCapacity {
  const max = snapshot.machine.maxRunners ?? defaultMaxRunners;
  const runners = snapshot.operations
    .filter(
      (operation) =>
        operation.command === "runner.run" &&
        ["accepted", "running", "action_required"].includes(operation.status),
    )
    .map((operation) => {
      const progress = Schema.is(RunnerProgress)(operation.result) ? operation.result : undefined;
      const start = snapshot.operations.find((item) => item.key === `${operation.id}:start`);
      const instance = snapshot.instances.find(
        (item) => item.id === (progress?.instanceId ?? start?.id),
      );
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
  const preparationBusy =
    snapshot.preparationBusy === true ||
    snapshot.operations.some(
      (operation) =>
        [
          "environment.prepare-linux",
          "environment.resume",
          "environment.install-macos",
          "environment.install-windows",
          "environment.resume-windows",
          "environment.resume-macos",
          "environment.open-macos-setup",
        ].includes(operation.command) && ["accepted", "running"].includes(operation.status),
    );
  const ready = snapshot.environments.filter((item) => item.state === "ready");
  const reservations = runners.flatMap(({ operation, progress, instance }) => {
    if (instance) return [];
    const environmentId =
      progress?.environmentId ??
      snapshot.activities?.find(
        (activity) => activity.id === (operation.activityId ?? operation.id),
      )?.environmentId;
    const environment = ready.find((item) => item.id === environmentId);
    // Before binding resolution, reserve the largest possible resources and a macOS slot.
    return [
      {
        id: operation.id,
        environmentId: environment?.id ?? ready.find((item) => item.os === "macos")?.id ?? "",
        cpu: environment?.cpu ?? Math.max(0, ...ready.map((item) => item.cpu)),
        memoryMiB: environment?.memoryMiB ?? Math.max(0, ...ready.map((item) => item.memoryMiB)),
        status: "starting" as const,
        pid: 0,
        createdAt: operation.createdAt,
      },
    ];
  });
  const reserved = { ...snapshot, instances: [...snapshot.instances, ...reservations] };
  const environments = ready.map((environment) => {
    let available = 0;
    if (!snapshot.machine.paused && !preparationBusy) {
      while (
        available < max - active &&
        !instanceAdmissionError(reserved, environment, host, available + 1)
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
  };
}
