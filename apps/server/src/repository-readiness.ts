import type {
  CloudRepositoryReadiness,
  ReadinessCheck,
  RepositoryReadiness,
  RepositoryReadinessInput,
} from "../../../packages/protocol/src/readiness.js";
import { VectisError, type Environment } from "../../../packages/protocol/src/index.js";
import { cachePrivilegeError } from "../../../packages/runner/src/cache-guest.js";

export async function repositoryReadiness(
  input: RepositoryReadinessInput,
  environments: () => readonly Environment[],
  readCloud: (input: RepositoryReadinessInput) => Promise<CloudRepositoryReadiness>,
  cachePrivilege: (environment: Environment) => boolean | undefined = () => undefined,
): Promise<RepositoryReadiness> {
  let cloud: CloudRepositoryReadiness | undefined;
  const checks: ReadinessCheck[] = [];
  try {
    cloud = await readCloud(input);
    checks.push(
      {
        id: "cloud",
        status: "ok",
        message: "This machine is paired and the cloud is reachable.",
      },
      ...cloud.checks,
    );
  } catch (error) {
    if (error instanceof VectisError && error.code === "repository_access_denied") throw error;
    const known = error instanceof VectisError;
    const code = known ? error.code : "cloud_unavailable";
    checks.push({
      id: "cloud",
      status: ["cloud_unconfigured", "machine_revoked"].includes(code) ? "blocked" : "unknown",
      code,
      message: known ? error.message : "The cloud readiness report could not be read.",
      nextStep: known ? error.nextStep : "Check the cloud connection and retry readiness.",
      target: { area: "connections" },
    });
    for (const id of [
      "github.account",
      "github.app",
      "github.admin",
      "github.approval",
      "repository.binding",
    ])
      checks.push({
        id,
        status: "unknown",
        message: "This check requires an authorized cloud readiness report.",
        nextStep: "Resolve cloud access, then retry readiness.",
        target: { area: "connections" },
      });
  }
  const environmentId =
    "environmentId" in input ? (input.environmentId ?? cloud?.environmentId) : cloud?.environmentId;
  const localEnvironments = environments();
  const environment = environmentId
    ? localEnvironments.find((item) => item.id === environmentId)
    : "repositoryName" in input
      ? localEnvironments.find((item) => item.state === "ready")
      : undefined;
  const unresolved = "bindingId" in input && !cloud;
  const check: ReadinessCheck = {
    id: "environment",
    status: unresolved ? "unknown" : environment?.state === "ready" ? "ok" : "blocked",
    message: unresolved
      ? "The binding's environment cannot be identified without cloud access."
      : environment?.state === "ready"
        ? `Environment ${environment.id} is ready on this machine.`
        : environment
          ? `Environment ${environment.id} still needs setup.`
          : environmentId
            ? `Environment ${environmentId} is unavailable on this machine.`
            : "Select or prepare a ready environment on this machine.",
    ...(unresolved || environment?.state === "ready"
      ? {}
      : { code: environmentId && !environment ? "environment_unavailable" : "setup_required" }),
    ...(environment?.state === "ready"
      ? {}
      : {
          nextStep: unresolved
            ? "Restore cloud access so the binding's environment can be identified, then retry readiness."
            : "Select a local environment and complete its preparation, then retry readiness.",
          target: {
            area: unresolved ? "connections" : "environments",
            ...(environmentId ? { section: environmentId } : {}),
          } as const,
        }),
  };
  checks.splice(checks.length - 1, 0, check);
  if (cloud?.cacheVolumeEnabled && environment) {
    const allowed = cachePrivilege(environment);
    const error = cachePrivilegeError();
    checks.splice(checks.length - 1, 0, {
      id: "cache.guest_sudo",
      status: allowed === false ? "attention" : allowed ? "ok" : "unknown",
      message:
        allowed === false
          ? error.message
          : allowed
            ? "The guest has the privileges needed to mount cache volumes."
            : "Cache mount privileges have not been checked for this environment image.",
      ...(allowed === false
        ? {
            code: error.code,
            nextStep: error.nextStep,
            target: { area: "environments", section: environment.id } as const,
          }
        : {}),
    });
  }
  return {
    checks,
    ready: checks.every((check) => check.status === "ok" || check.status === "attention"),
  };
}
