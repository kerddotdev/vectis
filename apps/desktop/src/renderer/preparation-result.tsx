import { Schema } from "effect";
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
}: {
  result: unknown;
  resumable: boolean;
  macos?: boolean;
}) {
  const { submit } = useStateApi();
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
              type: macos ? "environment.resume-macos" : "environment.resume",
              id: result.setupId,
            })
          }
        >
          Resume preparation
        </button>
      )}
    </div>
  );
}
