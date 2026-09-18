import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { LaunchAgent } from "./launch-agent.js";

const macTest = test.skipIf(process.platform !== "darwin");
macTest("aliases share a registration and unrelated definitions are preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "vectis-agent-test-"));
  try {
    const agent = await LaunchAgent.forHome(join(root, "state"), { directory: root });
    await mkdir(agent.home);
    await symlink(agent.home, join(root, "alias"));
    const alias = await LaunchAgent.forHome(join(root, "alias"), { directory: root });
    expect(alias.label).toBe(agent.label);
    await writeFile(agent.path, "unrelated registration");
    await expect(agent.uninstall()).rejects.toMatchObject({ code: "installation_conflict" });
    expect(await readFile(agent.path, "utf8")).toBe("unrelated registration");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

macTest("failed bootout preserves registration and all user data", async () => {
  const root = await mkdtemp(join(tmpdir(), "vectis-agent-test-"));
  const calls: ReadonlyArray<string>[] = [];
  try {
    const agent = await LaunchAgent.forHome(join(root, "state"), {
      directory: root,
      execute: async (_executable, args) => {
        calls.push(args);
        if (args[0] === "bootout") throw new Error("denied");
        return "";
      },
    });
    await writeFile(
      agent.path,
      `<key>Label</key><string>${agent.label}</string><key>VECTIS_HOME</key><string>${agent.home}</string>`,
    );
    await mkdir(agent.home);
    await writeFile(join(agent.home, "data"), "preserve");
    await expect(agent.uninstall()).rejects.toThrow("denied");
    expect(calls.map((args) => args[0])).toEqual(["print", "bootout"]);
    expect(await agent.installed()).toBe(true);
    expect(await readFile(join(agent.home, "data"), "utf8")).toBe("preserve");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

macTest("unreachable service with an outstanding lock is not unloaded", async () => {
  const root = await mkdtemp(join(tmpdir(), "vectis-agent-test-"));
  const calls: ReadonlyArray<string>[] = [];
  try {
    const agent = await LaunchAgent.forHome(join(root, "state"), {
      directory: root,
      execute: async (_executable, args) => {
        calls.push(args);
        return "";
      },
    });
    await mkdir(agent.home);
    await writeFile(join(agent.home, "service.lock"), "owned service still shutting down");
    await writeFile(
      agent.path,
      `<key>Label</key><string>${agent.label}</string><key>VECTIS_HOME</key><string>${agent.home}</string>`,
    );
    await expect(agent.uninstall()).rejects.toMatchObject({ code: "service_shutdown_pending" });
    expect(calls).toEqual([]);
    expect(await agent.installed()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
