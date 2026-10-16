import { ConvexError } from "convex/values";
import { Schema } from "effect";
import { redact } from "./redact.js";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { api } from "../../../convex/_generated/api.js";
import { decodeCommand, VectisError } from "../../protocol/src/index.js";
import type { VectisClient } from "./index.js";

export type RemoteOperation = FunctionReturnType<typeof api.operations.pending>[number];
export type Acknowledgement = FunctionArgs<typeof api.operations.acknowledge>;

export async function advanceRemoteOperation(
  remote: RemoteOperation,
  local: Pick<VectisClient, "submit" | "operationByKey">,
  acknowledge: (args: Acknowledgement) => Promise<unknown>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (remote.phase === "accepted") {
    try {
      await acknowledge({ id: remote._id, phase: "claimed" });
    } catch (error) {
      if (
        !(
          error instanceof ConvexError &&
          Schema.is(Schema.Struct({ code: Schema.Literal("operation_cancelled") }))(error.data)
        )
      )
        throw error;
    }
    return;
  }
  if (remote.phase !== "claimed" && remote.phase !== "running") return;
  if (remote.cancelRequested) {
    const operation = await local.operationByKey(`remote:${remote._id}`, signal).catch((error) => {
      if (error instanceof VectisError && error.code === "operation_missing") return undefined;
      throw error;
    });
    if (!operation) {
      if (remote.phase === "claimed") await acknowledge({ id: remote._id, phase: "cancelled" });
      else
        await acknowledge({
          id: remote._id,
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
        `remote-cancel:${remote._id}`,
        signal,
      );
      return;
    }
  }
  const operation = await local.submit(
    decodeCommand(JSON.parse(remote.commandJson)),
    `remote:${remote._id}`,
    signal,
  );
  signal.throwIfAborted();
  if (operation.status === "accepted") return;
  if (
    remote.phase === "claimed" &&
    (operation.status === "running" || operation.status === "succeeded")
  ) {
    await acknowledge({ id: remote._id, phase: "running" });
    if (operation.status === "succeeded") return;
  }
  if (operation.status === "running") return;
  await acknowledge({
    id: remote._id,
    phase: operation.status,
    resultJson: JSON.stringify({
      operationId: operation.id,
      status: operation.status,
      message: redact(operation.message).slice(0, 1000),
      resultAvailableLocally: operation.result !== undefined,
    }),
  });
}
