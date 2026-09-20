import {
  commandActivity,
  type Activity,
  type ActivityBase,
  type Command,
  type GuestOS,
  type Operation,
} from "../../../packages/protocol/src/index.js";

export function preparationOS(command: string): typeof GuestOS.Type | undefined {
  switch (command) {
    case "environment.prepare-linux":
    case "environment.resume":
      return "linux";
    case "environment.install-macos":
    case "environment.resume-macos":
    case "environment.open-macos-setup":
    case "environment.connect-macos-guest":
    case "environment.verify-macos-guest":
    case "environment.finish-macos-setup":
    case "environment.discard-macos":
      return "macos";
    case "environment.install-windows":
    case "environment.resume-windows":
      return "windows";
  }
}

export type ActivityLink = { activityId: string; create?: ActivityBase };

export function activityFor(operationId: string, command: Command): ActivityLink | undefined {
  const classification = commandActivity[command.type];
  if (classification === "setting" || (command.type === "job.scan" && command.automatic)) return;
  const continuation = classification === "continuation";
  const activityId = continuation && "id" in command ? command.id : operationId;
  const os = preparationOS(command.type);
  const subject: ActivityBase["subject"] = os
    ? { type: "preparation", setupId: activityId, os }
    : command.type === "runner.run" || command.type === "runner.reconcile"
      ? {
          type: "runner",
          ...("jobId" in command && command.jobId !== undefined
            ? { requestedJob: { jobId: command.jobId } }
            : {}),
        }
      : { type: "command", command: command.type };
  const environmentId =
    "environmentId" in command
      ? command.environmentId
      : command.type === "environment.start" || (os && !continuation && "id" in command)
        ? command.id
        : undefined;
  return {
    activityId,
    create: {
      id: activityId,
      kind: subject.type === "runner" ? "github" : "vectis",
      subject,
      rootOperationId: continuation ? activityId : operationId,
      createdAt: new Date().toISOString(),
      ...(environmentId === undefined ? {} : { environmentId }),
      ...("bindingId" in command ? { bindingId: command.bindingId } : {}),
    },
  };
}

export function decidingMember(base: ActivityBase, members: readonly Operation[]) {
  return base.subject.type === "preparation"
    ? members.at(-1)
    : members.find((member) => member.id === base.rootOperationId);
}

export function isTerminal(status: Operation["status"]) {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function deriveActivity(
  base: ActivityBase,
  members: readonly Operation[],
): Activity | undefined {
  const deciding = decidingMember(base, members);
  if (!deciding) return;
  const discarded =
    base.subject.type === "preparation" &&
    deciding.command === "environment.discard-macos" &&
    deciding.status === "succeeded";
  const status = discarded ? "cancelled" : deciding.status;
  const updatedAt = members.reduce(
    (latest, member) => (member.updatedAt > latest ? member.updatedAt : latest),
    deciding.updatedAt,
  );
  return {
    ...base,
    status,
    message: discarded
      ? "The unregistered macOS setup was explicitly discarded."
      : deciding.message,
    updatedAt,
    ...(isTerminal(status) ? { completedAt: deciding.updatedAt } : {}),
  };
}
