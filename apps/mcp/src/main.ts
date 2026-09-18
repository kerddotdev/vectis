#!/usr/bin/env node
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { KeychainCredentials } from "../../../packages/client/src/keychain.js";
import { LaunchAgent } from "../../../packages/client/src/launch-agent.js";
import { localClient } from "../../../packages/client/src/local.js";
import { createMcpServer } from "./server.js";

async function main() {
  const { values } = parseArgs({
    options: { home: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    process.stdout.write(
      "Usage: vectis-mcp [--home <directory>]\nRuns the Vectis MCP server over stdio. Start the local service first. No credentials are passed in arguments.\n",
    );
    return;
  }
  const home = values.home ?? process.env.VECTIS_HOME ?? join(homedir(), ".vectis");
  const server = createMcpServer(
    () => localClient(home),
    () => LaunchAgent.forHome(home),
    process.env.VECTIS_KEYCHAIN_HELPER
      ? { home, credentials: new KeychainCredentials(process.env.VECTIS_KEYCHAIN_HELPER) }
      : undefined,
  );
  await server.connect(new StdioServerTransport());
}
main().catch(() => {
  process.stderr.write(
    "Vectis MCP could not connect. Run vectis service start with the same home directory.\n",
  );
  process.exitCode = 1;
});
