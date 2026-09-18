import { access, open, readFile, rename, rm } from "node:fs/promises";
import { VectisError } from "../../protocol/src/index.js";
import { DatabaseSync } from "node:sqlite";

export async function withRegistrationLock<T>(path: string, action: () => Promise<T>) {
  const database = new DatabaseSync(`${path}.control.sqlite`);
  try {
    try {
      database.exec("BEGIN IMMEDIATE");
    } catch {
      throw new VectisError(
        "service_control_busy",
        "Another client is changing this service registration.",
        "Wait for that operation to finish, then retry.",
      );
    }
    return await action();
  } finally {
    database.close();
  }
}

export interface RegistrationRuntime {
  stopIfIdle(): Promise<void>;
  unload(): Promise<void>;
  start(): Promise<unknown>;
}

export async function replaceRegistration(
  path: string,
  next: string,
  runtime: RegistrationRuntime,
) {
  const previous = await readFile(path, "utf8");
  const backup = `${path}.update-backup`;
  await assertNoPendingUpdate(path);
  await atomicWrite(backup, previous);
  try {
    await runtime.stopIfIdle();
  } catch (error) {
    await rm(backup);
    throw error;
  }
  try {
    await runtime.unload();
    await atomicWrite(path, next);
    const result = await runtime.start();
    await rm(backup);
    return result;
  } catch (error) {
    try {
      await recoverRegistration(path, runtime);
    } catch {
      throw new VectisError(
        "update_recovery_required",
        "The runtime update failed and automatic recovery did not complete.",
        "Keep both runtime packages. Run vectis service recover-update with the same --home.",
      );
    }
    throw new VectisError(
      "update_rolled_back",
      `The new runtime could not start; the previous registration was restored. ${error instanceof Error ? error.message : ""}`,
      "Keep the previous runtime installed, inspect service.log, and retry with a working package.",
    );
  }
}

export async function recoverRegistration(path: string, runtime: RegistrationRuntime) {
  const backup = `${path}.update-backup`;
  let previous: string;
  try {
    previous = await readFile(backup, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new VectisError("update_missing", "No interrupted runtime update needs recovery.");
    throw error;
  }
  await runtime.stopIfIdle();
  await runtime.unload();
  await atomicWrite(path, previous);
  const result = await runtime.start();
  await rm(backup);
  return result;
}

export async function assertNoPendingUpdate(path: string) {
  try {
    await access(`${path}.update-backup`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new VectisError(
    "update_incomplete",
    "An earlier runtime update needs recovery.",
    "Run vectis service recover-update with the same --home before retrying.",
  );
}

async function atomicWrite(path: string, content: string) {
  const pending = `${path}.pending`;
  const file = await open(pending, "w", 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(pending, path);
}
