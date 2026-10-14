import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readServiceLog } from "./logs.js";

let home: string | undefined;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

test("returns the newest lines and says when older lines were left out", async () => {
  home = await mkdtemp(join(tmpdir(), "vectis-logs-"));
  expect(await readServiceLog(home, 10)).toEqual({ lines: [], truncated: false });
  await writeFile(join(home, "service.log"), "one\ntwo\nthree\n");
  expect(await readServiceLog(home, 2)).toEqual({ lines: ["two", "three"], truncated: true });
  expect(await readServiceLog(home, 10)).toEqual({
    lines: ["one", "two", "three"],
    truncated: false,
  });
});

test("reads at most the log tail without starting mid-line", async () => {
  home = await mkdtemp(join(tmpdir(), "vectis-logs-"));
  const line = "x".repeat(99);
  await writeFile(join(home, "service.log"), `${line}\n`.repeat(3000) + "last\n");
  const log = await readServiceLog(home, 1000);
  expect(log.truncated).toBe(true);
  expect(log.lines.at(-1)).toBe("last");
  expect(log.lines.every((entry) => entry === line || entry === "last")).toBe(true);
});

test("multiline private keys are redacted before selecting the requested lines", async () => {
  home = await mkdtemp(join(tmpdir(), "vectis-logs-pem-"));
  const canary = "PrivateKeyCanary123456789";
  await writeFile(
    join(home, "service.log"),
    `runner-name\n-----BEGIN PRIVATE KEY-----\n${canary}\n-----END PRIVATE KEY-----\nexit 23\n`,
  );
  const log = await readServiceLog(home, 2);
  expect(log.lines).toEqual(["[redacted]", "exit 23"]);
  expect(JSON.stringify(log)).not.toContain(canary);
});

test("a bounded tail never exposes a credential whose identifying prefix was cut off", async () => {
  home = await mkdtemp(join(tmpdir(), "vectis-logs-long-"));
  const canary = "LongLogCanary123456789";
  await writeFile(join(home, "service.log"), `Authorization: Bearer ${canary.repeat(10000)}`);
  expect(await readServiceLog(home, 10)).toEqual({ lines: [], truncated: true });
  await writeFile(
    join(home, "service.log"),
    `Authorization: Bearer ${canary.repeat(10000)}\nrunner-name exit 23\n`,
  );
  expect(await readServiceLog(home, 10)).toEqual({
    lines: ["runner-name exit 23"],
    truncated: true,
  });
});
