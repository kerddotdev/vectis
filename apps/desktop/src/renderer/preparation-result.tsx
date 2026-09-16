import { Schema } from "effect";
import { useStateApi } from "./state.js";
const Progress = Schema.Struct({
  setupId: Schema.String,
  receivedBytes: Schema.optional(Schema.Number),
  directory: Schema.optional(Schema.String),
  nextStep: Schema.optional(Schema.String),
});
export function PreparationResult({ result, resumable }: { result: unknown; resumable: boolean }) {
  const { submit } = useStateApi();
  if (!Schema.is(Progress)(result)) return null;
  return (
    <div>
      {result.receivedBytes !== undefined && (
        <p>Downloaded {Math.floor(result.receivedBytes / 1024 ** 2)} MiB</p>
      )}
      {result.directory && <p>Image directory: {result.directory}</p>}
      {result.nextStep && <p>{result.nextStep}</p>}
      {resumable && (
        <button onClick={() => void submit({ type: "environment.resume", id: result.setupId })}>
          Resume preparation
        </button>
      )}
    </div>
  );
}
