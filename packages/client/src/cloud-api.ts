import { Schema } from "effect";
import {
  MachineApi,
  CloudErrorBody,
  type MachinePath,
  type MachineRequest,
  type MachineResponse,
} from "../../protocol/src/cloud.js";
import { VectisError } from "../../protocol/src/index.js";
import { machineBearer, type CloudConnection } from "./machine-auth.js";
import type { KeychainCredentials } from "./keychain.js";

export const removalCodes = ["machine_unauthorized", "machine_revoked", "machine_rejected"];

export function cloudError(body: CloudErrorBody) {
  if (body.code.startsWith("scale_set_"))
    return new VectisError(
      body.code === "scale_set_unavailable" && [401, 403].includes(body.status ?? 0)
        ? "scale_set_auth_failed"
        : body.code,
      body.message ?? "Scale set control was refused.",
      body.nextStep,
    );
  if (
    [
      "actor_not_allowed",
      "actor_unknown",
      "approval_required",
      "job_required",
      "job_not_queued",
      "automatic_disabled",
      "repository_access_changed",
      "runner_labels_mismatch",
    ].includes(body.code)
  )
    return new VectisError(
      body.code,
      body.message ?? "The repository access policy or job state no longer permits this runner.",
      body.nextStep ?? "Refresh the job and repository policy before starting a new runner.",
    );
  const repositoryError = [
    "public_runner_approval_required",
    "private_runner_approval_required",
    "repository_admin_required",
    "github_app_not_installed",
    "github_unavailable",
    "github_rate_limited",
    "machine_revoked",
    "cloud_unconfigured",
    "cloud_unavailable",
    "github_account_missing",
    "github_app_unavailable",
    "machine_unauthorized",
    "binding_limit",
    "invalid_repository_binding",
    "repository_access_denied",
    "installation_changed",
    "setup_required",
    "environment_unavailable",
  ].includes(body.code);
  return new VectisError(
    body.code,
    body.message ?? `Repository access was refused: ${body.code}.`,
    body.nextStep ??
      (repositoryError
        ? "Check repository readiness and resolve the reported prerequisite, then retry."
        : "Check repository access and inspect the operation before retrying."),
  );
}

export function createCloudApi(
  connection: CloudConnection,
  credentials: Pick<KeychainCredentials, "get">,
  fetcher: typeof fetch = globalThis.fetch,
) {
  return {
    async call<P extends MachinePath>(
      path: P,
      input: MachineRequest<P>,
      signal: AbortSignal,
    ): Promise<MachineResponse<P>> {
      signal.throwIfAborted();
      const bearer = await machineBearer(connection, credentials, signal);
      if (!bearer)
        throw new VectisError("machine_revoked", "The machine credential is no longer available.");
      let response: Response;
      try {
        response = await fetcher(`${connection.deploymentUrl}${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal,
          redirect: "error",
        });
      } catch {
        signal.throwIfAborted();
        throw new VectisError("cloud_unavailable", "The machine cloud connection is unavailable.");
      }
      const value: unknown = await response.json().catch(() => undefined);
      signal.throwIfAborted();
      if (!response.ok) {
        const error = Schema.decodeUnknownOption(CloudErrorBody)(value);
        if (error._tag === "Some") throw cloudError(error.value);
        throw new VectisError("cloud_unavailable", "The machine cloud connection is unavailable.");
      }
      try {
        return decoders[path](value);
      } catch (error) {
        if (path === "/machine/scale-sets/open" || path === "/machine/scale-sets/refresh")
          throw new VectisError(
            "scale_set_protocol_invalid",
            "The cloud returned an invalid scale set grant.",
          );
        throw error;
      }
    },
  };
}

const decoders: { [P in MachinePath]: (value: unknown) => MachineResponse<P> } = {
  "/machine/sync": Schema.decodeUnknownSync(MachineApi["/machine/sync"].response),
  "/machine/operations/acknowledge": Schema.decodeUnknownSync(
    MachineApi["/machine/operations/acknowledge"].response,
  ),
  "/machine/inspections/respond": Schema.decodeUnknownSync(
    MachineApi["/machine/inspections/respond"].response,
  ),
  "/machine/github/accounts": Schema.decodeUnknownSync(
    MachineApi["/machine/github/accounts"].response,
  ),
  "/machine/repositories/connect": Schema.decodeUnknownSync(
    MachineApi["/machine/repositories/connect"].response,
  ),
  "/machine/repositories/disconnect": Schema.decodeUnknownSync(
    MachineApi["/machine/repositories/disconnect"].response,
  ),
  "/machine/repositories/readiness": Schema.decodeUnknownSync(
    MachineApi["/machine/repositories/readiness"].response,
  ),
  "/machine/repositories/set-automatic": Schema.decodeUnknownSync(
    MachineApi["/machine/repositories/set-automatic"].response,
  ),
  "/machine/repositories/set-infra-rerun": Schema.decodeUnknownSync(
    MachineApi["/machine/repositories/set-infra-rerun"].response,
  ),
  "/machine/repositories/set-capacity-mode": Schema.decodeUnknownSync(
    MachineApi["/machine/repositories/set-capacity-mode"].response,
  ),
  "/machine/repositories/set-cache-volume": Schema.decodeUnknownSync(
    MachineApi["/machine/repositories/set-cache-volume"].response,
  ),
  "/machine/repositories/set-access": Schema.decodeUnknownSync(
    MachineApi["/machine/repositories/set-access"].response,
  ),
  "/machine/jobs/list": Schema.decodeUnknownSync(MachineApi["/machine/jobs/list"].response),
  "/machine/jobs/scan": Schema.decodeUnknownSync(MachineApi["/machine/jobs/scan"].response),
  "/machine/jobs/refresh": Schema.decodeUnknownSync(MachineApi["/machine/jobs/refresh"].response),
  "/machine/jobs/logs": Schema.decodeUnknownSync(MachineApi["/machine/jobs/logs"].response),
  "/machine/runners/reconcile": Schema.decodeUnknownSync(
    MachineApi["/machine/runners/reconcile"].response,
  ),
  "/machine/runners/prepare": Schema.decodeUnknownSync(
    MachineApi["/machine/runners/prepare"].response,
  ),
  "/machine/runners/status": Schema.decodeUnknownSync(
    MachineApi["/machine/runners/status"].response,
  ),
  "/machine/runners/release": Schema.decodeUnknownSync(
    MachineApi["/machine/runners/release"].response,
  ),
  "/machine/scale-sets/open": Schema.decodeUnknownSync(
    MachineApi["/machine/scale-sets/open"].response,
  ),
  "/machine/scale-sets/refresh": Schema.decodeUnknownSync(
    MachineApi["/machine/scale-sets/refresh"].response,
  ),
  "/machine/scale-sets/close": Schema.decodeUnknownSync(
    MachineApi["/machine/scale-sets/close"].response,
  ),
  "/machine/runs/control": Schema.decodeUnknownSync(MachineApi["/machine/runs/control"].response),
  "/machine/migrations/analyze": Schema.decodeUnknownSync(
    MachineApi["/machine/migrations/analyze"].response,
  ),
  "/machine/migrations/publish": Schema.decodeUnknownSync(
    MachineApi["/machine/migrations/publish"].response,
  ),
};
