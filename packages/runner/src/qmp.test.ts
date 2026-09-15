import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";
import { waitForQemu, qemuSshPort } from "./qmp.js";

for (const running of [true, false]) {
  test(`QMP readiness requires running=${running ? "true" : "true and rejects stopped"}`, async () => {
    const source = `const readline = require("node:readline");
process.stdout.write(JSON.stringify({QMP:{}})+"\\n");
readline.createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({id:request.id, return:request.execute==="query-status" ? {running:${running}} : request.execute==="human-monitor-command" ? "  TCP[HOST_FORWARD] 18 127.0.0.1 54321 10.0.2.15 22 0 0" : {}})+"\\n");
});`;
    const child = spawn(process.execPath, ["-e", source], { stdio: ["pipe", "pipe", "ignore"] });
    const closed = once(child, "close");
    try {
      if (running) await expect(waitForQemu(child)).resolves.toBe(54321);
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

test("SSH discovery rejects wildcard, ambiguous and invalid forwards", () => {
  const valid = "  TCP[HOST_FORWARD] 18 127.0.0.1 54321 10.0.2.15 22 0 0";
  expect(qemuSshPort(valid)).toBe(54321);
  for (const report of [
    valid.replace("127.0.0.1", "0.0.0.0"),
    valid + "\n" + valid,
    valid.replace("54321", "0"),
    valid.replace("54321", "65536"),
    valid.replace("10.0.2.15", "10.0.2.16"),
    valid.replace("22 0 0", "80 0 0"),
  ]) {
    expect(() => qemuSshPort(report)).toThrow();
  }
});
