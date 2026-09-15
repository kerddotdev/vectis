import { spawn } from "node:child_process";
import electron from "electron";
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...environment } = process.env;
const child = spawn(electron, [".", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...environment, VECTIS_NODE_EXECUTABLE: process.execPath },
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
