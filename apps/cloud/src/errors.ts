import type { CloudErrorBody } from "../../../packages/protocol/src/cloud.js";

// Every refusal a handler can explain. index.ts turns it into a CloudErrorBody response; anything
// else becomes 500 cloud_unavailable. Extra fields (for example resetAt) are passed through.
export class CloudError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
    readonly details: Omit<CloudErrorBody, "code"> & Record<string, unknown> = {},
  ) {
    super(details.message ?? code);
  }
  body(): CloudErrorBody & Record<string, unknown> {
    return { ...this.details, code: this.code };
  }
}

export const unauthorizedMachine = () =>
  new CloudError("machine_unauthorized", 401, { nextStep: "Reconnect this machine to Vectis." });
export const unauthorizedHuman = () =>
  new CloudError("unauthorized", 401, { nextStep: "Sign in to Vectis." });
