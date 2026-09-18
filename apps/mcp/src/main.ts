#!/usr/bin/env node
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { KeychainCredentials } from "../../../packages/client/src/keychain.js";
import { LaunchAgent } from "../../../packages/client/src/launch-agent.js";
import { localClient } from "../../../packages/client/src/local.js";
import { controllerClient } from "../../../packages/client/src/controller.js";
import { RemoteClient } from "../../../packages/client/src/remote.js";
import { VectisError } from "../../../packages/protocol/src/index.js";
import { createMcpServer } from "./server.js";

async function main() {
  const { values } = parseArgs({
    options: { home: { type: "string" }, machine: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    process.stdout.write(
      "Usage: vectis-mcp [--home <directory>] [--machine <id>]\nRuns the Vectis MCP server over stdio. Start the local service first, or use vectis login and machine list to select a remote machine. Remote sessions never fall back to local control. No credentials are passed in arguments.\n",
    );
    return;
  }
  const home = values.home ?? process.env.VECTIS_HOME ?? join(homedir(), ".vectis");
  const helper = process.env.VECTIS_KEYCHAIN_HELPER;
  const credentials = helper ? new KeychainCredentials(helper) : undefined;
  const machine = values.machine;
  if (machine && !credentials)
    throw new VectisError("runtime_missing", "Remote control requires VECTIS_KEYCHAIN_HELPER.");
  const server = createMcpServer(
    async () => {
      if (!machine) return localClient(home);
      if (!credentials) throw new VectisError("runtime_missing", "Keychain is unavailable.");
      return new RemoteClient(await controllerClient(home, credentials), machine);
    },
    machine ? undefined : () => LaunchAgent.forHome(home),
    !machine && credentials ? { home, credentials } : undefined,
    machine,
  );
  await server.connect(new StdioServerTransport());
}
main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof VectisError
      ? `${error.code}: ${error.message} ${error.nextStep}\n`
      : "Vectis MCP could not start. Check --help and the selected connection.\n",
  );
  process.exitCode = 1;
});
