import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { runProcess } from "../packages/runner/src/process.js";

async function prove(helper: string, image: string, directory: string) {
  await mkdir(directory);
  const marker = randomUUID();
  const seed = join(directory, "seed");
  await mkdir(seed);
  await writeFile(
    join(seed, "meta-data"),
    `instance-id: ${marker}\nlocal-hostname: vectis-proof\n`,
  );
  await writeFile(
    join(seed, "user-data"),
    `#cloud-config
users: []
disable_root: true
ssh_pwauth: false
runcmd:
  - [sh, -c, 'if test -e /var/tmp/vectis-proof-marker; then echo VECTIS_DIRTY > /dev/hvc0; else touch /var/tmp/vectis-proof-marker; echo VECTIS_CLEAN_${marker} > /dev/hvc0; uname -sm > /dev/hvc0; cat /etc/os-release > /dev/hvc0; fi']
power_state:
  mode: poweroff
  timeout: 30
  condition: true
`,
  );
  const seedImage = join(directory, "seed.iso");
  await runProcess("/usr/bin/hdiutil", [
    "makehybrid",
    "-o",
    seedImage,
    seed,
    "-iso",
    "-joliet",
    "-default-volume-name",
    "cidata",
  ]);
  const work = join(directory, "work.img");
  await copyFile(image, work, constants.COPYFILE_FICLONE);
  const child = spawn(
    helper,
    ["run", "linux", work, "2", "2048", join(directory, "efi.bin"), seedImage],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let serial = "";
  let events = "";
  let error: Error | undefined;
  child.once("error", (issue) => {
    error = issue;
  });
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    serial = (serial + chunk).slice(-131072);
  });
  child.stdout.on("data", (chunk: string) => {
    events = (events + chunk).slice(-16384);
  });
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  let force: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => {
    child.kill("SIGTERM");
    force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5000);
  }, 180000);
  try {
    await closed;
  } finally {
    clearTimeout(deadline);
    clearTimeout(force);
    child.stdin.destroy();
  }
  const successful =
    !error &&
    child.exitCode === 0 &&
    serial.includes(`VECTIS_CLEAN_${marker}`) &&
    serial.includes("Linux aarch64") &&
    serial.includes('VERSION_ID="24.04"') &&
    !serial.includes("VECTIS_DIRTY");
  if (!successful)
    throw new Error(
      `Linux proof failed. Helper events: ${events}. Serial tail: ${serial.slice(-4000)}`,
    );
  return {
    clean: true,
    guest: "Ubuntu 24.04 ARM64",
    commandExecuted: true,
    shutdownObserved: true,
  };
}

async function main() {
  const { values } = parseArgs({
    options: { helper: { type: "string" }, image: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help || !values.helper || !values.image) {
    process.stdout.write(
      "Usage: pnpm proof:linux --helper <signed-vectis-vm> --image <raw-Ubuntu-24.04-ARM64-disk>\nCreates two disposable guests, checks clean state and guest commands, then removes all work files. Requires macOS, hdiutil, and a helper signed with the virtualization entitlement.\n",
    );
    process.exitCode = values.help ? 0 : 2;
    return;
  }
  const home = await mkdtemp(join(tmpdir(), "vectis-linux-proof-"));
  try {
    for (let index = 1; index <= 2; index++) {
      const result = await prove(
        resolve(values.helper),
        resolve(values.image),
        join(home, String(index)),
      );
      process.stdout.write(JSON.stringify({ pass: index, ...result }) + "\n");
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
main().catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});
