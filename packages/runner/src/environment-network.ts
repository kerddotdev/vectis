import {
  VectisError,
  type Environment,
  type EnvironmentNetwork,
} from "../../protocol/src/index.js";

export function environmentNetwork(environment: Environment): EnvironmentNetwork {
  const egress = environment.os === "windows" ? (environment.egress ?? "internet_only") : "open";
  return { egress, enforcement: egress === "internet_only" ? "enforced" : "not_enforced" };
}

export function validateEnvironmentEgress(environment: Environment) {
  if (environment.egress === "internet_only" && environment.os !== "windows")
    throw new VectisError(
      "egress_unsupported",
      "Apple Virtualization NAT cannot restrict guest network access yet; this environment can reach the host and local network.",
      "Use open egress or a Windows environment with internet_only egress.",
    );
}
