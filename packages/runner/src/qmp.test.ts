import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";
import { waitForQemu } from "./qmp.js";

for (const running of [true, false]) {
  test(`QMP readiness requires running=${running ? "true" : "true and rejects stopped"}`, async () => {
    const source = `const readline = require("node:readline");
process.stdout.write(JSON.stringify({QMP:{}})+"\\n");
readline.createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({id:request.id, return:request.execute==="query-status" ? {running:${running}} : {}})+"\\n");
});`;
    const child = spawn(process.execPath, ["-e", source], { stdio: ["pipe", "pipe", "ignore"] });
    const closed = once(child, "close");
    try {
      if (running) await expect(waitForQemu(child)).resolves.toBeUndefined();
      else await expect(waitForQemu(child)).rejects.toMatchObject({ code: "vm_start_failed" });
    } finally {
      child.stdin.end();
      await closed;
    }
  });
}

test("the observed HVF TPM mapping failure explains the required runtime without exposing raw diagnostics", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.stderr.write("tpm-tis-device: HV_BAD_ARGUMENT private-path\\n"); process.exitCode=1;',
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  await expect(waitForQemu(child)).rejects.toMatchObject({ code: "runtime_incompatible" });
  await closed;
});
