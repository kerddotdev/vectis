import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";
import { requestQemuShutdown, waitForQemu, qemuSshPort } from "./qmp.js";

test.each(["accepted", "rejected", "timeout", "invalid", "oversized"])(
  "QMP shutdown reuses the negotiated channel: %s",
  async (mode) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
console.log(JSON.stringify({QMP:{}}));
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === 'shutdown') {
    if (request.execute !== 'system_powerdown') process.exit(97);
    if ('${mode}' === 'timeout') return;
    if ('${mode}' === 'invalid') return console.log('invalid');
    if ('${mode}' === 'oversized') return console.log('x'.repeat(65537));
    console.log(JSON.stringify({event:'POWERDOWN'}));
    console.log(JSON.stringify({id:'unrelated', return:{}}));
    const response = JSON.stringify({id:request.id, ...('${mode}' === 'rejected' ? {error:{class:'CommandNotFound'}} : {return:{}})});
    process.stdout.write(response.slice(0, 5));
    setImmediate(() => process.stdout.write(response.slice(5)+'\\n'));
    return;
  }
  console.log(JSON.stringify({id:request.id, return: request.id === 'status' ? {running:true} : request.id === 'network' ? 'TCP[HOST_FORWARD] 1 127.0.0.1 54321 10.0.2.15 22 0 0' : {}}));
});`,
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    const closed = once(child, "close");
    try {
      await waitForQemu(child);
      const errorListeners = child.listenerCount("error");
      await expect(requestQemuShutdown(child, mode === "timeout" ? 20 : 1000)).resolves.toBe(
        mode === "accepted",
      );
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(child.stdout.listenerCount("data")).toBe(0);
      expect(child.stdin.listenerCount("error")).toBe(0);
      expect(child.listenerCount("error")).toBe(errorListeners);
    } finally {
      child.stdin.end();
      await closed;
    }
  },
);

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
