"use node";
import { createHash } from "node:crypto";
import { ConvexError, v } from "convex/values";
import { Schema } from "effect";
import { action } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { repositoryAccess } from "./githubAccess.js";
import { runControlCommand } from "./runCommands.js";
import {
  GitHubAppClient,
  GitHubApiError,
  GitHubPermissionError,
  GitHubUnavailableError,
  GitHubRateLimitError,
  GitHubUncertainError,
} from "../packages/github/src/app-client.js";
import { RunControlCommand, RunControlOutcome } from "../packages/protocol/src/runs.js";

import { unconfirmedRunCommand } from "../packages/github/src/run-control.js";

const Run = Schema.Struct({
  id: Schema.Int,
  run_attempt: Schema.Int,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  repository: Schema.Struct({ id: Schema.Int }),
});
const JobsPage = Schema.Struct({
  total_count: Schema.Int,
  jobs: Schema.Array(Schema.Struct({ conclusion: Schema.NullOr(Schema.String) })),
});
const DispatchDetails = Schema.Struct({
  workflow_run_id: Schema.Int.check(Schema.isGreaterThan(0)),
  html_url: Schema.String,
});
function sleep(delay: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal.addEventListener("abort", abort, { once: true });
  });
}
function rejected(code: string, message: string, nextStep: string): RunControlOutcome {
  return { state: "rejected", code, message, nextStep };
}

export const control = action({
  args: { key: v.string(), command: runControlCommand },
  handler: async (ctx, args): Promise<RunControlOutcome> => {
    let command: RunControlCommand;
    try {
      command = Schema.decodeUnknownSync(RunControlCommand, { onExcessProperty: "error" })(
        args.command,
      );
    } catch {
      throw new ConvexError({
        code: "invalid_run_request",
        message: "Invalid GitHub run command.",
        nextStep: "Inspect the command schema, workflow, ref and input limits.",
      });
    }
    const authority = await ctx.runQuery(internal.runnerLeases.authorize, {
      bindingId: command.bindingId,
      preparing: false,
    });
    const canonical =
      command.type === "workflow.dispatch"
        ? {
            ...command,
            ...(command.inputs
              ? {
                  inputs: Object.fromEntries(
                    Object.entries(command.inputs).sort(([a], [b]) => a.localeCompare(b)),
                  ),
                }
              : {}),
          }
        : command;
    const requestHash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
    const { fresh, receipt } = await ctx.runMutation(internal.runReceipts.claim, {
      bindingId: command.bindingId,
      key: args.key,
      requestHash,
    });
    // A submitted receipt may belong to a live action or a crashed one. Neither permits another POST.
    if (!fresh) return receipt.outcome ?? unconfirmedRunCommand(command);
    let posted = false;
    let responseReceived = false;
    let acceptedOutcome: Extract<RunControlOutcome, { state: "accepted" }> | undefined;
    let outcome: RunControlOutcome;
    try {
      const client = new GitHubAppClient(authority.app);
      const access = await repositoryAccess(client, {
        owner: authority.binding.repositoryOwner ?? authority.account.login,
        repo: authority.binding.repositoryName,
        repositoryId: authority.binding.repositoryId,
        githubUserId: authority.account.githubId,
        githubLogin: authority.account.login,
        purpose: "actions-write",
        ...(command.type === "run.cancel" ? { actionsOperation: "cancel" } : {}),
      });
      if (access.installationId !== authority.binding.installationId)
        throw new ConvexError({
          code: "installation_changed",
          message: "The repository installation changed.",
          nextStep: "Reconnect this repository binding before retrying.",
        });
      const readRun = async (runId: number, signal?: AbortSignal) => {
        const run = Schema.decodeUnknownSync(Run)(
          await client.request(
            access.token,
            `${access.path}/actions/runs/${runId}`,
            undefined,
            signal,
          ),
        );
        if (run.id !== runId || run.repository.id !== access.repositoryId)
          throw new ConvexError({
            code: "run_repository_mismatch",
            message: "The run does not belong to this binding's repository.",
            nextStep: "Select a run from the connected repository.",
          });
        return run;
      };
      const before =
        command.type !== "workflow.dispatch" ? await readRun(command.runId) : undefined;
      if (
        before &&
        command.type === "run.cancel" &&
        !["queued", "in_progress", "waiting", "pending", "requested"].includes(before.status)
      )
        throw new ConvexError({
          code: "run_not_active",
          message: "This run is not active and cannot be cancelled.",
          nextStep: "Select an active run.",
        });
      if (before && command.type === "run.rerun-failed") {
        if (before.status !== "completed")
          throw new ConvexError({
            code: "run_not_rerunnable",
            message: "The run is still active.",
            nextStep: "Wait for the run to complete before rerunning failed jobs.",
          });
        let failed = false;
        for (let page = 1; page <= 10; page++) {
          const jobs = Schema.decodeUnknownSync(JobsPage)(
            await client.request(
              access.token,
              `${access.path}/actions/runs/${before.id}/attempts/${before.run_attempt}/jobs?per_page=100&page=${page}`,
            ),
          );
          failed = jobs.jobs.some(
            (job) => job.conclusion === "failure" || job.conclusion === "timed_out",
          );
          if (failed || page * 100 >= jobs.total_count) break;
          if (!jobs.jobs.length || page === 10)
            throw new ConvexError({
              code: "run_jobs_unverified",
              message: "Failed jobs could not be verified within the API limit.",
              nextStep: "Inspect the run's jobs on GitHub before retrying.",
            });
        }
        if (!failed)
          throw new ConvexError({
            code: "run_not_rerunnable",
            message: "The run has no failed jobs.",
            nextStep: "Select a completed run with failed jobs.",
          });
      }
      const current = await ctx.runQuery(internal.runnerLeases.authorize, {
        bindingId: command.bindingId,
        preparing: false,
      });
      if (
        !current.binding.enabled ||
        current.binding.repositoryId !== access.repositoryId ||
        current.binding.installationId !== access.installationId ||
        current.account._id !== authority.account._id
      )
        throw new ConvexError({
          code: "repository_access_denied",
          message: "Repository access changed before submission.",
          nextStep: "Check the binding and GitHub App access before retrying.",
        });
      posted = true;
      if (command.type === "workflow.dispatch") {
        // API 2026-03-10 always returns run details; return_run_details was removed.
        const response = await client.post(
          access.token,
          `${access.path}/actions/workflows/${encodeURIComponent(String(command.workflow))}/dispatches`,
          { ref: command.ref, ...(command.inputs ? { inputs: command.inputs } : {}) },
        );
        responseReceived = true;
        if (response.status === 204) {
          outcome = {
            state: "accepted",
            message: "GitHub accepted the workflow dispatch; run ID is unknown.",
          };
        } else if (response.status === 200) {
          const details = Schema.decodeUnknownSync(DispatchDetails)(response.body);
          outcome = {
            state: "accepted",
            message: "GitHub returned the dispatched workflow run.",
            runId: details.workflow_run_id,
            htmlUrl: details.html_url,
          };
        } else outcome = unconfirmedRunCommand(command);
      } else {
        if (!before) throw new Error("Missing run observation.");
        const response = await client.post(
          access.token,
          `${access.path}/actions/runs/${command.runId}/${command.type === "run.cancel" ? "cancel" : "rerun-failed-jobs"}`,
          {},
          "discard",
        );
        responseReceived = true;
        if (!(response.status >= 200 && response.status < 300)) {
          outcome = unconfirmedRunCommand(command);
        } else {
          acceptedOutcome = {
            state: "accepted",
            message:
              command.type === "run.cancel"
                ? "GitHub accepted the cancellation; the run is still stopping."
                : "GitHub accepted the rerun; the new attempt is not yet visible.",
            ...(command.type === "run.cancel"
              ? { cancellation: "requested" as const }
              : { rerun: "requested" as const }),
            runId: before.id,
            runAttempt: before.run_attempt,
            htmlUrl: before.html_url,
          };
          const abort = new AbortController();
          const windowMs = command.type === "run.cancel" ? 20000 : 5000;
          const deadline = setTimeout(() => abort.abort(), windowMs);
          try {
            let delay = 1000;
            while (!abort.signal.aborted) {
              try {
                const after = await readRun(command.runId, abort.signal);
                const observed =
                  command.type === "run.rerun-failed"
                    ? after.run_attempt > before.run_attempt
                    : after.status === "completed" || after.status === "cancelled";
                acceptedOutcome = {
                  ...acceptedOutcome,
                  runAttempt: after.run_attempt,
                  htmlUrl: after.html_url,
                };
                if (observed) {
                  acceptedOutcome = {
                    ...acceptedOutcome,
                    message:
                      command.type === "run.rerun-failed"
                        ? "A newer GitHub run attempt was observed."
                        : "The run was observed stopped after the cancellation request.",
                    ...(command.type === "run.cancel"
                      ? { cancellation: "observed" as const }
                      : { rerun: "observed" as const }),
                  };
                  break;
                }
              } catch {
                // A failed observation does not undo GitHub's acceptance of the POST.
              }
              await sleep(delay, abort.signal);
              delay = Math.min(delay * 2, 8000);
            }
          } finally {
            clearTimeout(deadline);
            abort.abort();
          }
          outcome = acceptedOutcome;
        }
      }
    } catch (error) {
      if (acceptedOutcome) outcome = acceptedOutcome;
      else if (responseReceived) outcome = unconfirmedRunCommand(command);
      else if (error instanceof GitHubUncertainError) outcome = unconfirmedRunCommand(command);
      else if (error instanceof GitHubUnavailableError || error instanceof GitHubRateLimitError)
        outcome = rejected(error.code, error.message, error.nextStep);
      else if (error instanceof GitHubPermissionError)
        outcome = rejected(error.code, error.message, error.nextStep);
      else if (
        error instanceof ConvexError &&
        Schema.is(
          Schema.Struct({ code: Schema.String, message: Schema.String, nextStep: Schema.String }),
        )(error.data)
      )
        outcome = posted
          ? unconfirmedRunCommand(command)
          : rejected(error.data.code, error.data.message, error.data.nextStep);
      else if (error instanceof GitHubApiError && error.status >= 400 && error.status < 500)
        outcome = rejected(
          "github_run_request_rejected",
          error.message,
          "Inspect the run or workflow and current GitHub App access before retrying.",
        );
      else
        outcome = posted
          ? unconfirmedRunCommand(command)
          : rejected(
              "run_preflight_failed",
              "The run command was not submitted to GitHub.",
              "Check repository access and run state before retrying with a new operation key.",
            );
    }
    try {
      await ctx.runMutation(internal.runReceipts.finish, { id: receipt._id, outcome });
    } catch (error) {
      if (posted) return unconfirmedRunCommand(command);
      throw error;
    }
    return outcome;
  },
});
