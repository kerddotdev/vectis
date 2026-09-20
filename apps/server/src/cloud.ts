import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { startCloudRelay } from "../../../packages/client/src/cloud-relay.js";
import { CloudConnection } from "../../../packages/client/src/machine-auth.js";
import { KeychainCredentials } from "../../../packages/client/src/keychain.js";
import type { VectisClient } from "../../../packages/client/src/index.js";
import type { CloudStatus } from "../../../packages/protocol/src/index.js";
import type { JobObservations } from "../../../packages/protocol/src/jobs.js";

export async function configuredRelay(
  home: string,
  local: VectisClient,
  helper: string | undefined,
  onState: (status: CloudStatus) => void,
  onChange: () => void,
  onJobObservations: (entries: JobObservations) => void,
) {
  try {
    const contents = await readFile(join(home, "cloud.json"), "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (contents === null) {
      onState({ state: "unconfigured" });
      return;
    }
    const connection = Schema.decodeUnknownSync(CloudConnection, { onExcessProperty: "error" })(
      JSON.parse(contents),
    );
    if (!helper) throw new Error("Keychain helper is not configured.");
    return startCloudRelay(
      connection,
      local,
      new KeychainCredentials(helper),
      (state) => onState({ state }),
      onChange,
      onJobObservations,
    );
  } catch {
    onState({
      state: "unavailable",
      message: "Check cloud.json in the service home and the VECTIS_KEYCHAIN_HELPER configuration.",
    });
    return;
  }
}
