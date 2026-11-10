import { notImplemented, type MachineHandler } from "../context.js";

export const analyzeMigration: MachineHandler<"/machine/migrations/analyze"> = async () =>
  notImplemented();
export const publishMigration: MachineHandler<"/machine/migrations/publish"> = async () =>
  notImplemented();
