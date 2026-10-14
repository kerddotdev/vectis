import type { RunControlCommand, RunControlOutcome } from "../../protocol/src/runs.js";

export function unconfirmedRunCommand(
  command: RunControlCommand,
): Extract<RunControlOutcome, { state: "uncertain" }> {
  return {
    state: "uncertain",
    code: "run_command_unconfirmed",
    message: "The GitHub run command could not be confirmed.",
    nextStep:
      "Check the run on GitHub before retrying. Reuse the same operation key to read its receipt; never blindly retry with a new key.",
    ...("runId" in command ? { runId: command.runId } : {}),
  };
}
