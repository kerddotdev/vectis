import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test.each([0, 17])("natural VM exit preserves code %s through the supervisor", async (code) => {
  const home = await mkdtemp(join(tmpdir(), "vectis-supervisor-exit-"));
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./supervisor.ts", import.meta.url)),
      process.execPath,
      "-e",
      `process.stdin.resume(); process.stdin.once('data', () => process.exit(${code})); console.log('ready');`,
    ],
    {
      cwd: home,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...process.env,
        VECTIS_VM_TPM_EXECUTABLE: "",
        VECTIS_EXIT_RECEIPT: join(home, "receipt.json"),
        VECTIS_INSTANCE_ID: "test",
      },
    },
  );
  const closed = once(child, "close");
  try {
    await once(child.stdout, "data");
    child.stdin.write("shutdown\n");
    await closed;
    expect(child.exitCode).toBe(code);
    expect(child.signalCode).toBeNull();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
    await rm(home, { recursive: true, force: true });
  }
});

test.each([
  { name: "a clean VM exit", vmExitCode: 0, expectedCode: 0 },
  { name: "a failed VM exit", vmExitCode: 17, expectedCode: 17 },
  { name: "a VM that keeps running", vmExitCode: null, expectedCode: 1 },
])(
  "TPM exit before $name preserves the correct supervisor result",
  async ({ vmExitCode, expectedCode }) => {
    const home = await mkdtemp(join(tmpdir(), "vectis-tpm-exit-"));
    const helper = join(home, "tpm-helper");
    const receipt = join(home, "receipt.json");
    await writeFile(
      helper,
      `#!${process.execPath}
const net = require('node:net');
require('node:fs').writeFileSync('tpm.pid', String(process.pid));
net.createServer(socket => {
  socket.resume();
  socket.once('end', () => process.exit(0));
}).listen('tpm.sock');
`,
      { mode: 0o700 },
    );
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./supervisor.ts", import.meta.url)),
        process.execPath,
        "-e",
        `const socket = require('node:net').connect('tpm.sock', () => console.log(process.pid));
process.on('SIGTERM', () => {
  require('node:fs').writeFileSync('vm-stopped', 'SIGTERM');
  process.exit(0);
});
process.stdin.resume();
process.stdin.once('data', () => socket.end());
socket.once('close', () => {
  if (${vmExitCode} !== null) setTimeout(() => process.exit(${vmExitCode}), 150);
});`,
      ],
      {
        cwd: home,
        stdio: ["pipe", "pipe", "ignore"],
        env: {
          ...process.env,
          VECTIS_VM_TPM_EXECUTABLE: helper,
          VECTIS_EXIT_RECEIPT: receipt,
          VECTIS_INSTANCE_ID: "test",
        },
      },
    );
    const closed = once(child, "close");
    const deadline = setTimeout(() => child.kill("SIGTERM"), 6000);
    try {
      const [chunk] = await once(child.stdout, "data");
      const vmPid = Number(String(chunk).trim());
      const tpmPid = Number(await readFile(join(home, "tpm.pid"), "utf8"));
      child.stdin.write("shutdown\n");
      await closed;
      expect(child.exitCode).toBe(expectedCode);
      expect(child.signalCode).toBeNull();
      expect(() => process.kill(vmPid, 0)).toThrow();
      expect(() => process.kill(tpmPid, 0)).toThrow();
      if (vmExitCode === null)
        expect(await readFile(join(home, "vm-stopped"), "utf8")).toBe("SIGTERM");
      else
        await expect(readFile(join(home, "vm-stopped"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual({
        instanceId: "test",
        pid: child.pid,
      });
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("owner pipe closure terminates a child that ignores SIGTERM", async () => {
  const supervisor = fileURLToPath(new URL("./supervisor.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      supervisor,
      process.execPath,
      "-e",
      'process.on("SIGTERM", () => {}); process.stdout.write(String(process.pid)+"\\n"); setInterval(() => {},1000);',
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  const closed = once(child, "close");
  const deadline = setTimeout(() => child.kill("SIGTERM"), 5000);
  try {
    const [chunk] = await once(child.stdout, "data");
    const pid = Number(String(chunk).trim());
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    child.stdin.end();
    await closed;
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
});

test("exit receipts are written only after both the VM and private TPM have stopped", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-tpm-supervisor-"));
  const helper = join(home, "tpm-helper");
  const receipt = join(home, "exit-receipt.json");
  await writeFile(
    helper,
    `#!${process.execPath}\nrequire('node:net').createServer().listen('tpm.sock'); require('node:fs').writeFileSync('tpm.pid',String(process.pid)); process.on('SIGTERM',()=>{});`,
    { mode: 0o700 },
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./supervisor.ts", import.meta.url)),
      process.execPath,
      "-e",
      'process.stdout.write(String(process.pid)+"\\n"); setInterval(()=>{},1000);',
    ],
    {
      cwd: home,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...process.env,
        VECTIS_VM_TPM_EXECUTABLE: helper,
        VECTIS_EXIT_RECEIPT: receipt,
        VECTIS_INSTANCE_ID: "test",
      },
    },
  );
  const closed = once(child, "close");
  const deadline = setTimeout(() => child.kill("SIGTERM"), 5000);
  try {
    const [chunk] = await once(child.stdout, "data");
    const vmPid = Number(String(chunk).trim());
    const tpmPid = Number(await readFile(join(home, "tpm.pid"), "utf8"));
    child.stdin.end();
    await closed;
    expect(() => process.kill(vmPid, 0)).toThrow();
    expect(() => process.kill(tpmPid, 0)).toThrow();
    expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual({
      instanceId: "test",
      pid: child.pid,
    });
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
    await rm(home, { recursive: true, force: true });
  }
});
