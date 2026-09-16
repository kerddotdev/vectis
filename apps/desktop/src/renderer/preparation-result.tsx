import { Schema } from "effect";
import { useState } from "react";
import { useStateApi } from "./state.js";
const Progress = Schema.Struct({
  setupId: Schema.String,
  receivedBytes: Schema.optional(Schema.Number),
  directory: Schema.optional(Schema.String),
  nextStep: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.String),
});
export function PreparationResult({
  result,
  resumable,
  macos = false,
  windows = false,
}: {
  result: unknown;
  resumable: boolean;
  macos?: boolean;
  windows?: boolean;
}) {
  const { submit } = useStateApi();
  const [confirmation, setConfirmation] = useState("");
  if (!Schema.is(Progress)(result)) return null;
  return (
    <div>
      {result.receivedBytes !== undefined && (
        <p>Downloaded {Math.floor(result.receivedBytes / 1024 ** 2)} MiB</p>
      )}
      {result.directory && <p>Image directory: {result.directory}</p>}
      {result.nextStep && <p>{result.nextStep}</p>}
      {macos && result.phase === "setup_required" && (
        <button
          onClick={() => void submit({ type: "environment.open-macos-setup", id: result.setupId })}
        >
          Open guest setup console
        </button>
      )}
      {resumable && (!macos || result.phase === "interrupted") && (
        <button
          onClick={() =>
            void submit({
              type: macos
                ? "environment.resume-macos"
                : windows
                  ? "environment.resume-windows"
                  : "environment.resume",
              id: result.setupId,
            })
          }
        >
          Resume preparation
        </button>
      )}
      {macos && resumable && ["setup_required", "interrupted"].includes(result.phase ?? "") && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit({
              type: "environment.discard-macos",
              id: result.setupId,
              environmentId: confirmation.trim(),
            });
          }}
        >
          <label>
            Environment ID to permanently discard this unregistered setup
            <input
              required
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <button type="submit" disabled={!confirmation.trim()}>
            Discard setup files
          </button>
        </form>
      )}
    </div>
  );
}
