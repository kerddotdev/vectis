import { expect, test } from "vitest";
import { runProcess } from "./process.js";

test("reports unavailable executables without hanging", async () => {
  await expect(runProcess("/vectis-does-not-exist", [])).rejects.toMatchObject({
    code: "process_failed",
  });
});
test("bounds retained output", async () => {
  const result = await runProcess(process.execPath, [
    "-e",
    'process.stdout.write("x".repeat(100000))',
  ]);
  expect(result.length).toBe(65536);
});
test("cancels and reaps a command before returning", async () => {
  await expect(
    runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], AbortSignal.timeout(50)),
  ).rejects.toMatchObject({ code: "process_cancelled" });
});
