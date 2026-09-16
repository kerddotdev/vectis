import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Schema } from "effect";
import { MacInstallation, VectisError } from "../../../packages/protocol/src/index.js";
import { MacInstallationRecord, recoverMacInstallations } from "./macos-installation-task.js";
import type { Store } from "./store.js";

export async function discardMacInstallation(store: Store, id: string, environmentId: string) {
  await recoverMacInstallations(store);
  const record = Schema.decodeUnknownSync(MacInstallationRecord)(store.get("macInstallation", id));
  const snapshot = store.snapshot();
  const canonical = async (path: string) => realpath(path).catch(() => resolve(path));
  const root = await canonical(record.directory);
  const referencedPaths = [
    ...snapshot.environments.map((environment) => environment.basePath),
    ...snapshot.instances.flatMap((instance) =>
      instance.status !== "stopped" && instance.directory ? [instance.directory] : [],
    ),
  ];
  const referenced = (await Promise.all(referencedPaths.map(canonical))).some((path) => {
    const child = relative(root, path);
    return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith("../"));
  });
  if (record.configuration.id !== environmentId)
    throw new VectisError(
      "confirmation_mismatch",
      "Confirm the exact environment identifier before discarding setup.",
    );
  if (
    record.phase === "installing" ||
    record.phase === "setup_running" ||
    record.phase === "registered" ||
    referenced ||
    snapshot.environments.some(
      (environment) =>
        environment.id === environmentId ||
        resolve(environment.basePath) === resolve(join(record.directory, "base.bundle")),
    )
  )
    throw new VectisError(
      "installation_in_use",
      "Only a stopped, unregistered setup can be discarded.",
    );
  const expected = join(record.configuration.imageDirectory, basename(record.directory));
  if (resolve(record.directory) !== resolve(expected))
    throw new VectisError(
      "setup_directory_conflict",
      "The recorded setup directory does not match its owner.",
    );
  const directory = await lstat(record.directory).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (directory) {
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new VectisError(
        "setup_directory_conflict",
        "The setup path is not an owned directory.",
      );
    const owner = Schema.decodeUnknownSync(
      Schema.Struct({ id: Schema.String, configuration: MacInstallation }),
    )(JSON.parse(await readFile(join(record.directory, "setup.json"), "utf8")));
    if (
      !/^[a-zA-Z0-9-]+$/.test(owner.id) ||
      basename(record.directory) !== `vectis-${environmentId}-${owner.id}` ||
      JSON.stringify(owner.configuration) !== JSON.stringify(record.configuration)
    )
      throw new VectisError(
        "setup_directory_conflict",
        "The setup ownership marker does not match.",
      );
    await rm(record.directory, { recursive: true });
  }
  store.remove("macInstallation", id);
  for (const operation of snapshot.operations) {
    if (
      operation.status !== "action_required" ||
      ![
        "environment.install-macos",
        "environment.resume-macos",
        "environment.open-macos-setup",
      ].includes(operation.command)
    )
      continue;
    if (
      Schema.is(Schema.Struct({ setupId: Schema.String }))(operation.result) &&
      operation.result.setupId === id
    )
      store.update(operation, {
        status: "cancelled",
        message: "The unregistered macOS setup was explicitly discarded.",
        result: { setupId: id, phase: "discarded" },
      });
  }
  return { setupId: id, removedDirectory: record.directory };
}
