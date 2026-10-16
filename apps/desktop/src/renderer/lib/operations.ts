import { commandLabels as sharedCommandLabels } from "../../command-labels.js";

export const preparationCommands = [
  "environment.prepare-linux",
  "environment.resume",
  "environment.install-macos",
  "environment.resume-macos",
  "environment.open-macos-setup",
  "environment.connect-macos-guest",
  "environment.verify-macos-guest",
  "environment.finish-macos-setup",
  "environment.install-windows",
  "environment.resume-windows",
];
export const cancellableCommands = [
  "environment.install-macos",
  "environment.resume-macos",
  "environment.open-macos-setup",
  "environment.connect-macos-guest",
  "environment.verify-macos-guest",
  "environment.install-windows",
  "environment.resume-windows",
  "environment.prepare-linux",
  "environment.resume",
  "runner.run",
  "run.rerun-failed",
  "run.cancel",
  "workflow.dispatch",
  "job.refresh",
  "job.scan",
  "migration.analyze",
  "migration.publish",
  "repository.connect",
];
export const commandLabels: Record<string, string> = {
  ...sharedCommandLabels,
  "repository.cache": "Configure repository cache",
  "cache.clear": "Clear repository cache",
};
// A setting is confirmed after it happened, so its message is what changed, not what was asked.
export const settingLabels: Record<string, string> = {
  "repository.automatic": "Automatic runners updated",
  "repository.access": "Repository access updated",
  "repository.cache": "Repository cache updated",
  "cache.clear": "Repository cache cleared",
  "environment.configure": "Environment updated",
  "environment.register": "Environment registered",
  "environment.remove": "Environment removed",
  "instance.stop": "VM stopped",
  "instance.reconcile": "VM reconciled",
  "operation.cancel": "Operation closed",
  "machine.pause": "VM intake updated",
  "machine.configure": "Concurrent VMs updated",
};
