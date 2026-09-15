import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

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
