import { spawnSync } from "node:child_process";
import { Schema } from "effect";
import { expect, test } from "vitest";
import { linuxSeed } from "./linux-seed.js";

const CloudConfig = Schema.Struct({
  write_files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      content: Schema.String,
      encoding: Schema.optional(Schema.String),
    }),
  ),
});

function seedFiles() {
  const seed = linuxSeed({ id: "test", publicKey: "ssh-ed25519 AAAA synthetic" });
  return Schema.decodeUnknownSync(CloudConfig)(
    JSON.parse(seed.userdata.replace(/^#cloud-config\n/, "")),
  ).write_files;
}

function content(path: string) {
  const entry = seedFiles().find((file) => file.path === path);
  if (!entry) throw new Error(`Missing seed file: ${path}`);
  return entry.encoding === "b64"
    ? Buffer.from(entry.content, "base64").toString("utf8")
    : entry.content;
}

test("Rosetta boot setup checks the share tag and completes before SSH and Docker", () => {
  const unit = content("/opt/vectis/vectis-rosetta.service");
  expect(unit).toContain("DefaultDependencies=no");
  expect(unit).toContain("Type=oneshot");
  expect(unit).toContain(
    "ExecCondition=/bin/sh -c 'mkdir -p /run/rosetta && mount -t virtiofs -o ro,nosuid,nodev rosetta /run/rosetta'",
  );
  expect(unit).toContain("Requires=proc-sys-fs-binfmt_misc.mount");
  expect(unit).toMatch(/After=.*systemd-binfmt.service/);
  expect(unit).toContain("Before=ssh.service ssh.socket docker.service shutdown.target");
  const script = content("/usr/local/sbin/vectis-rosetta");
  expect(unit.indexOf("ExecCondition=")).toBeLessThan(unit.indexOf("ExecStart="));
  expect(script).toContain("test -x /run/rosetta/rosetta");
  const prepare = content("/opt/vectis/prepare.sh");
  expect(prepare).toContain(
    "install -m 0644 /opt/vectis/vectis-rosetta.service /etc/systemd/system/vectis-rosetta.service",
  );
  expect(prepare).toContain("systemctl enable vectis-rosetta.service");
  for (const shell of [script, prepare])
    expect(spawnSync("/bin/bash", ["-n"], { input: shell, encoding: "utf8" }).status).toBe(0);
});

test("Rosetta binfmt matches x86_64 executables and shared objects with container-safe CF flags", () => {
  const registration = content("/usr/local/sbin/vectis-rosetta").match(
    /'(:rosetta:M::[^']+)'/,
  )?.[1];
  if (!registration) throw new Error("Missing Rosetta binfmt registration");
  const fields = registration.split(":");
  expect(fields.slice(-2)).toEqual(["/run/rosetta/rosetta", "CF"]);
  const bytes = (value: string) =>
    Buffer.from(
      value.replaceAll(/\\x([0-9a-f]{2})/g, (_match: string, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      ),
      "latin1",
    );
  const magic = bytes(fields[4] ?? "");
  const mask = bytes(fields[5] ?? "");
  expect(magic).toHaveLength(20);
  expect(mask).toHaveLength(20);
  const matches = (elf: Buffer) =>
    magic.every(
      (byte, index) => ((elf[index] ?? 0) & (mask[index] ?? 0)) === (byte & (mask[index] ?? 0)),
    );
  for (const type of [2, 3]) {
    const elf = Buffer.from(magic);
    elf.writeUInt16LE(type, 16);
    expect(matches(elf)).toBe(true);
    elf.writeUInt16LE(183, 18);
    expect(matches(elf)).toBe(false);
  }
  const elf32 = Buffer.from(magic);
  elf32[4] = 1;
  expect(matches(elf32)).toBe(false);
});
