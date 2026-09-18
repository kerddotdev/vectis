import { resolve } from "node:path";
import { Schema } from "effect";
import type { Environment } from "../../../packages/protocol/src/index.js";
import { MacInstallationRecord } from "./macos-installation-task.js";
import type { Store } from "./store.js";

export function completeMacRegistration(store: Store, environment: Environment) {
  if (
    environment.os !== "macos" ||
    environment.state !== "ready" ||
    !environment.sshUser ||
    !environment.sshKeyPath ||
    !environment.knownHostsPath
  )
    return;
  for (const value of store.list("macInstallation")) {
    const record = Schema.decodeUnknownSync(MacInstallationRecord)(value);
    if (
      record.phase !== "setup_required" ||
      record.configuration.id !== environment.id ||
      !record.bundle ||
      resolve(record.bundle) !== resolve(environment.basePath)
    )
      continue;
    store.put("macInstallation", record.id, { ...record, phase: "registered" });
    for (const operation of store.snapshot().operations) {
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
        !Schema.is(Schema.Struct({ setupId: Schema.String }))(operation.result) ||
        operation.result.setupId !== record.id
      )
        continue;
      store.update(operation, {
        status: "succeeded",
        message:
          "Installed macOS image registered with guest SSH configuration. Runner readiness is checked before each job.",
        result: { setupId: record.id, environmentId: environment.id, phase: "registered" },
      });
    }
  }
}
