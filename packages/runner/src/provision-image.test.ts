import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { cloneProvisionImage } from "./provision-image.js";
import { runProcess } from "./process.js";
import type { Environment } from "../../protocol/src/index.js";

test.skipIf(process.platform !== "darwin")(
  "cloning a symlinked Linux source creates an independent disk",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "vectis-clone-source-"));
    try {
      const source = join(home, "source.img");
      const basePath = join(home, "alias.img");
      const sshKeyPath = join(home, "key");
      const directory = join(home, "derived");
      await writeFile(source, "parent");
      await symlink(source, basePath);
      await writeFile(sshKeyPath, "synthetic-key", { mode: 0o600 });
      await mkdir(directory);
      const parent: Environment = {
        id: "parent",
        name: "Parent",
        os: "linux",
        state: "ready",
        cpu: 1,
        memoryMiB: 512,
        basePath,
        sshUser: "vectis",
        sshKeyPath,
        sshHostKeyMode: "instance",
      };
      const derived = await cloneProvisionImage(
        parent,
        "derived",
        directory,
        {},
        new AbortController().signal,
      );
      await writeFile(derived.basePath, "new-image");
      expect(await readFile(source, "utf8")).toBe("parent");
      expect(await readFile(derived.basePath, "utf8")).toBe("new-image");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("Windows overlays pin an absolute backing path and own their cloned firmware, TPM and SSH pins", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-provision-overlay-"));
  try {
    const source = join(home, "parent");
    const directory = join(home, "derived");
    await mkdir(source);
    await mkdir(directory);
    await mkdir(join(source, "tpm-data"));
    await symlink(join(source, "tpm-data"), join(source, "tpm"));
    for (const [name, value] of [
      ["disk.qcow2", "parent-disk"],
      ["uefi-vars.fd", "parent-vars"],
      ["tpm/state", "parent-tpm"],
      ["guest-key", "parent-key"],
    ]) {
      if (name) await writeFile(join(source, name), value ?? "", { mode: 0o600 });
    }
    await runProcess("/usr/bin/ssh-keygen", [
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      join(source, "host-key"),
    ]);
    const publicKey = (await readFile(join(source, "host-key.pub"), "utf8")).trim();
    await writeFile(join(source, "known_hosts"), `parent ${publicKey}\n`);
    await runProcess("/usr/bin/ssh-keygen", ["-H", "-f", join(source, "known_hosts")]);
    const qemuImg = join(home, "fake-qemu-img.cjs");
    await writeFile(
      qemuImg,
      `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.writeFileSync(args.at(-1), JSON.stringify(args));`,
      { mode: 0o700 },
    );
    const parent: Environment = {
      id: "parent",
      name: "Parent",
      os: "windows",
      state: "ready",
      cpu: 1,
      memoryMiB: 512,
      basePath: join(source, "disk.qcow2"),
      firmwarePath: join(source, "code.fd"),
      firmwareVarsPath: join(source, "uefi-vars.fd"),
      tpmStatePath: join(source, "tpm"),
      sshUser: "vectis",
      sshKeyPath: join(source, "guest-key"),
      knownHostsPath: join(source, "known_hosts"),
    };
    const environment = await cloneProvisionImage(
      parent,
      "derived",
      directory,
      { qemuImg },
      new AbortController().signal,
    );
    expect(JSON.parse(await readFile(environment.basePath, "utf8"))).toEqual([
      "create",
      "-f",
      "qcow2",
      "-F",
      "qcow2",
      "-b",
      await realpath(parent.basePath),
      join(directory, "disk.qcow2"),
    ]);
    expect(environment).toMatchObject({
      firmwareVarsPath: join(directory, "uefi-vars.fd"),
      tpmStatePath: join(directory, "tpm"),
      sshKeyPath: join(directory, "guest-key"),
      knownHostsPath: join(directory, "known_hosts"),
    });
    expect(await readFile(join(directory, "known_hosts"), "utf8")).toBe(`derived ${publicKey}\n`);
    await writeFile(join(directory, "uefi-vars.fd"), "new-vars");
    await writeFile(join(directory, "tpm/state"), "new-tpm");
    expect(await readFile(parent.basePath, "utf8")).toBe("parent-disk");
    expect(await readFile(parent.firmwareVarsPath ?? "", "utf8")).toBe("parent-vars");
    expect(await readFile(join(source, "tpm/state"), "utf8")).toBe("parent-tpm");
    expect((await stat(join(directory, "guest-key"))).mode & 0o777).toBe(0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
