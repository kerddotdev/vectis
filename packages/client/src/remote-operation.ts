import { redact } from "./redact.js";
import type { RemoteOperation, MachineRequest } from "../../protocol/src/cloud.js";
export type { RemoteOperation } from "../../protocol/src/cloud.js";
import { decodeCommand, VectisError } from "../../protocol/src/index.js";
import type { VectisClient } from "./index.js";

export type Acknowledgement = MachineRequest<"/machine/operations/acknowledge">;

export async function advanceRemoteOperation(
  remote: RemoteOperation,
  local: Pick<VectisClient, "submit" | "operationByKey">,
  acknowledge: (args: Acknowledgement) => Promise<unknown>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (remote.phase === "accepted") {
    try {
      await acknowledge({ id: remote.id, phase: "claimed" });
    } catch (error) {
      if (!(error instanceof VectisError && error.code === "operation_cancelled")) throw error;
    }
    return;
  }
  if (remote.phase !== "claimed" && remote.phase !== "running") return;
  if (remote.cancelRequested) {
    const operation = await local.operationByKey(`remote:${remote.id}`, signal).catch((error) => {
      if (error instanceof VectisError && error.code === "operation_missing") return undefined;
      throw error;
    });
    if (!operation) {
      if (remote.phase === "claimed") await acknowledge({ id: remote.id, phase: "cancelled" });
      else
        await acknowledge({
          id: remote.id,
          phase: "action_required",
          resultJson: JSON.stringify({
            status: "action_required",
            message: "The host operation is missing. Inspect host recovery before retrying.",
            resultAvailableLocally: false,
          }),
        });
      return;
    }
    if (operation.status === "accepted" || operation.status === "running") {
      await local.submit(
        { type: "operation.cancel", id: operation.id },
        `remote-cancel:${remote.id}`,
        signal,
      );
      return;
    }
  }
  const operation = await local.submit(
    decodeCommand(JSON.parse(remote.commandJson)),
    `remote:${remote.id}`,
    signal,
  );
  signal.throwIfAborted();
  if (operation.status === "accepted") return;
  if (
    remote.phase === "claimed" &&
    (operation.status === "running" || operation.status === "succeeded")
  ) {
    await acknowledge({ id: remote.id, phase: "running" });
    if (operation.status === "succeeded") return;
  }
  if (operation.status === "running") return;
  await acknowledge({
    id: remote.id,
    phase: operation.status,
    resultJson: JSON.stringify({
      operationId: operation.id,
      status: operation.status,
      message: redact(operation.message).slice(0, 1000),
      ...(typeof operation.result === "object" &&
      operation.result !== null &&
      "code" in operation.result &&
      operation.result.code === "cache_volume_requires_guest_sudo"
        ? { code: operation.result.code }
        : {}),
      resultAvailableLocally: operation.result !== undefined,
    }),
  });
}
