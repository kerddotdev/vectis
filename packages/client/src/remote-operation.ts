import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { api } from "../../../convex/_generated/api.js";
import { decodeCommand } from "../../protocol/src/index.js";
import type { VectisClient } from "./index.js";

export type RemoteOperation = FunctionReturnType<typeof api.operations.pending>[number];
export type Acknowledgement = FunctionArgs<typeof api.operations.acknowledge>;

export async function advanceRemoteOperation(
  remote: RemoteOperation,
  local: Pick<VectisClient, "submit" | "status">,
  acknowledge: (args: Acknowledgement) => Promise<unknown>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (remote.phase === "accepted") {
    await acknowledge({ id: remote._id, phase: "claimed" });
    return;
  }
  if (remote.phase !== "claimed" && remote.phase !== "running") return;
  if (remote.cancelRequested) {
    const operation = (await local.status(signal)).operations.find(
      (item) => item.key === `remote:${remote._id}`,
    );
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
      message: operation.message.slice(0, 1000),
      resultAvailableLocally: operation.result !== undefined,
    }),
  });
}
