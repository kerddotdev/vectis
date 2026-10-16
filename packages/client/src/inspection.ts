import { redact } from "./redact.js";
import { Schema } from "effect";
import { LocalQuery } from "../../protocol/src/controller.js";
import { VectisError } from "../../protocol/src/index.js";
import type { VectisClient } from "./index.js";

export async function answerInspection(
  queryJson: string,
  local: VectisClient,
  signal: AbortSignal,
  maxResponseBytes = 256 * 1024,
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
        case "repository.readiness":
          return local.repositoryReadiness(query.input, signal);
        case "repositories":
          return local.repositories();
        case "github.accounts":
          return local.githubAccounts();
        case "capabilities":
          return local.capabilities();
        case "jobs":
          return local.jobs(query.bindingId);
        case "job.logs": {
          const { name: _name, ...input } = query;
          return local.jobLogs(input, signal);
        }
        case "operation":
          return local.operation(query.id, signal);
        case "operation.key":
          return local.operationByKey(query.key, signal);
        case "activities":
          return local.activities(signal);
        case "activity":
          return local.activity(query.id, signal);
        case "logs":
          return local.logs(query.lines);
      }
    })();
    signal.throwIfAborted();
    const encoded = JSON.stringify({ ok: true, result });
    if (new TextEncoder().encode(encoded).byteLength > maxResponseBytes)
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
      message: redact(issue.message),
      nextStep: redact(issue.nextStep),
    });
  }
}
