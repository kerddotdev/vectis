import { Schema } from "effect";
import { Identifier, VectisError } from "../../../packages/protocol/src/index.js";

export function desktopTarget(action: unknown, input: unknown) {
  if (input === undefined) return undefined;
  const machineId = Schema.decodeUnknownSync(Identifier)(input);
  if (
    typeof action !== "string" ||
    action.startsWith("service.") ||
    action.startsWith("cloud.") ||
    action.startsWith("choose")
  )
    throw new VectisError(
      "local_action_required",
      "This action is available only when This Mac is selected.",
      "Enter a path on the remote machine, or switch to This Mac for local setup.",
    );
  return machineId;
}
