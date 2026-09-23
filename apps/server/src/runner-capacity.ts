import {
  defaultMaxRunners,
  VectisError,
  type Environment,
  type Snapshot,
} from "../../../packages/protocol/src/index.js";

type Host = { cpus: number; memoryBytes: number };

export function instanceAdmissionError(
  snapshot: Snapshot,
  environment: Environment,
  host: Host,
  count = 1,
): VectisError | undefined {
  const active = snapshot.instances.filter((instance) => instance.status === "running");
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

export function runnerCapacity(snapshot: Snapshot, host: Host) {
  const max = snapshot.machine.maxRunners ?? defaultMaxRunners;
  const active = snapshot.operations.filter(
    (operation) =>
      operation.command === "runner.run" &&
      ["accepted", "running", "action_required"].includes(operation.status),
  ).length;
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
  const environment = snapshot.environments
    .filter((item) => item.state === "ready")
    .sort((a, b) => b.cpu - a.cpu || b.memoryMiB - a.memoryMiB)[0];
  // An accepted runner holds its slot before its VM runs, so its resources are reserved here too.
  const booting = Math.max(
    0,
    active - snapshot.instances.filter((instance) => instance.status === "running").length,
  );
  let available = 0;
  if (environment && !snapshot.machine.paused && !preparationBusy) {
    while (
      available < max - active &&
      !instanceAdmissionError(snapshot, environment, host, booting + available + 1)
    )
      available++;
  }
  return { max, active, available };
}
