import { Schema } from "effect";
import { LocalQuery } from "../../protocol/src/controller.js";
import { VectisError } from "../../protocol/src/index.js";
import type { VectisClient } from "./index.js";

export async function answerInspection(
  queryJson: string,
  local: VectisClient,
  signal: AbortSignal,
) {
  try {
    signal.throwIfAborted();
    const query = Schema.decodeUnknownSync(LocalQuery, { onExcessProperty: "error" })(
      JSON.parse(queryJson),
    );
    const result = await (async () => {
      switch (query.name) {
        case "status":
          return local.status(signal);
        case "storage":
          return local.storage();
        case "doctor":
          return local.doctor();
        case "repositories":
          return local.repositories();
        case "github.accounts":
          return local.githubAccounts();
        case "capabilities":
          return local.capabilities();
        case "jobs":
          return local.jobs(query.bindingId);
        case "operation":
          return local.operation(query.id, signal);
      }
    })();
    signal.throwIfAborted();
    const encoded = JSON.stringify({ ok: true, result });
    if (encoded.length > 262144)
      throw new VectisError(
        "query_result_too_large",
        "The inspection exceeds the remote response limit.",
        "Query an individual operation or inspect the full report locally.",
      );
    return encoded;
  } catch (error) {
    signal.throwIfAborted();
    const issue =
      error instanceof VectisError
        ? error
        : new VectisError("inspection_failed", "The local inspection could not be completed.");
    return JSON.stringify({
      ok: false,
      code: issue.code,
      message: issue.message,
      nextStep: issue.nextStep,
    });
  }
}
