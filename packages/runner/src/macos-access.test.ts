import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { prepareMacAccess, macEnrollmentArguments, macEnrollmentScript } from "./macos-access.js";
import { guestArguments } from "./guest.js";
import { runProcess } from "./process.js";

test("guest enrollment creates and reuses a private guest identity without a password", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vectis guest ' $(not-a-command) -"));
  try {
    const signal = AbortSignal.timeout(10000);
    const first = await prepareMacAccess(directory, "mac-setup", "192.168.64.20", signal);
    const publicKey = await readFile(first.connection.identityFile + ".pub", "utf8");
    const repeated = await prepareMacAccess(directory, "mac-setup", "192.168.64.21", signal);
    expect(await readFile(repeated.connection.identityFile + ".pub", "utf8")).toBe(publicKey);
    expect((await stat(first.connection.identityFile)).mode & 0o777).toBe(0o600);
    expect((await stat(repeated.path)).mode & 0o777).toBe(0o700);
    expect(await readFile(repeated.path, "utf8")).toContain("vectis@192.168.64.21");
    expect(macEnrollmentArguments(repeated.connection)).toContain("StrictHostKeyChecking=ask");
    await runProcess("/bin/sh", ["-n", repeated.path], signal);
    const configuration = await runProcess(
      "/usr/bin/ssh",
      ["-G", ...guestArguments(repeated.connection)],
      signal,
    );
    expect(configuration).toContain(`identityfile ${repeated.connection.identityFile}\n`);
    expect(configuration).toContain(`userknownhostsfile ${repeated.connection.knownHostsFile}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("enrollment rejects hostnames and invalid identities before preparing an SSH command", () => {
  const connection = {
    host: "192.168.64.20",
    port: 22,
    user: "vectis",
    identityFile: "/isolated/key",
    knownHostsFile: "/isolated/known_hosts",
    hostKeyAlias: "mac-setup",
  };
  expect(() => macEnrollmentScript({ ...connection, host: "example.com" })).toThrow();
  expect(() => macEnrollmentScript({ ...connection, user: "-oProxyCommand=bad" })).toThrow();
});
