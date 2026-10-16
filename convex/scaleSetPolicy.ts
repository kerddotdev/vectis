import { ConvexError } from "convex/values";
import { restrictiveAccess } from "../packages/github/src/access-policy.js";
import type { Doc } from "./_generated/dataModel.js";

export function assertScaleSetPolicy(access: Doc<"repositoryBindings">["access"]) {
  if (restrictiveAccess(access))
    throw new ConvexError({
      code: "scale_set_policy_unsupported",
      message: "Scale set messages do not identify the workflow actor or approval status.",
      nextStep: "Use demand capacity for actor restrictions or required approval.",
    });
}

export function assertScaleSetBinding(binding: Doc<"repositoryBindings">) {
  if (binding.capacityMode !== "scale_set") throw new ConvexError({ code: "scale_set_disabled" });
  if (!binding.enabled) throw new ConvexError({ code: "repository_access_denied" });
  if (!binding.automatic) throw new ConvexError({ code: "automatic_disabled" });
  assertScaleSetPolicy(binding.access);
}
