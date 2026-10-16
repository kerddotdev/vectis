import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, test } from "vitest";
import { linuxSeed } from "./linux-seed.js";
import { runnerPreinstallScript } from "./provision-scripts.js";
import { runnerVersion } from "./runner-release.js";

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
function preparationScript(home: string) {
  return content("/opt/vectis/prepare.sh")
    .replaceAll("/dev/hvc0", join(home, "serial.log"))
    .replaceAll("/var/log/vectis-prepare.log", join(home, "prepare.log"));
}

test("fresh Linux images retain the same verified runner used by derived environments", () => {
  const script = content("/opt/vectis/prepare.sh");
  expect(script).toContain(runnerPreinstallScript("linux", { dependencies: false }));
  expect(script).toContain("runuser -l vectis -c 'bash -s' <<'VECTIS_RUNNER'");
  const [userScript, rootScript] = script.split("VECTIS_RUNNER\n");
  expect(userScript).not.toContain("installdependencies.sh");
  expect(rootScript).toContain('"$runner_target/bin/installdependencies.sh"');
  expect(rootScript).toContain('chown -R vectis:vectis "$runner_target"');
  expect(script).not.toContain("sudo -n");
  expect(script).toContain("trap finish EXIT");
  expect(script).toContain("VECTIS_PREPARATION_FAILED_test step=%s exit=%s");
  expect(script).toMatch(/apt_get install -y --no-install-recommends [^\n]*\bzstd\b/);
  expect(script).not.toContain("/opt/vectis-bootstrap");
  expect(linuxSeed({ id: "test", publicKey: "ssh-ed25519 AAAA synthetic" }).userdata).toContain(
    "ALL=(ALL) NOPASSWD:ALL",
  );
});

test.each([
  { name: "success", downloadExit: 0, dependenciesExit: 0, expected: 0 },
  { name: "download failure", downloadExit: 22, dependenciesExit: 0, expected: 22 },
  { name: "root dependency failure", downloadExit: 0, dependenciesExit: 23, expected: 23 },
  {
    name: "poweroff failure",
    downloadExit: 0,
    dependenciesExit: 0,
    shutdownExit: 24,
    expected: 24,
  },
])("Linux preparation shell: $name", async (scenario) => {
  const home = await mkdtemp(join(tmpdir(), "vectis-seed-shell-"));
  const guestHome = join(home, "guest");
  const serial = join(home, "serial.log");
  try {
    await mkdir(guestHome);
    await writeFile(
      join(home, "dependencies.sh"),
      `#!/bin/bash\ntest "$USER" = root || exit 97\necho root-dependencies\nexit ${scenario.dependenciesExit}\n`,
      { mode: 0o700 },
    );
    const script = preparationScript(home).split("begin_step network\n")[0];
    if (!script) throw new Error("Missing preparation script");
    const result = spawnSync("/bin/bash", ["-s"], {
      input: `
uname() { echo aarch64; }
apt-get() { :; }
fuser() { return 1; }
usermod() { :; }
systemctl() { :; }
poweroff() { echo powered-off; return ${scenario.shutdownExit ?? 0}; }
getent() { printf 'vectis:x:1000:1000::%s:/bin/bash\\n' "$FIXTURE_GUEST_HOME"; }
runuser() {
  test "$1 $2 $3 $4" = '-l vectis -c bash -s' || return 98
  HOME="$FIXTURE_GUEST_HOME" USER=vectis /bin/bash -c "$4"
}
curl() {
  test "$USER" = vectis && test "$HOME" = "$FIXTURE_GUEST_HOME" || return 99
  touch "$target/runner.tar.gz"
  return ${scenario.downloadExit}
}
sha256sum() { cat >/dev/null; }
tar() { mkdir -p "$target/bin"; cp "$FIXTURE_ROOT/dependencies.sh" "$target/bin/installdependencies.sh"; }
chown() { printf '%s\\n' "$*" > "$FIXTURE_ROOT/ownership"; }
export -f curl sha256sum tar
${script}
printf 'VECTIS_PREPARED_test\\n'
completed=true
`,
      env: {
        ...process.env,
        HOME: home,
        USER: "root",
        FIXTURE_ROOT: home,
        FIXTURE_GUEST_HOME: guestHome,
      },
      cwd: home,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(scenario.expected);
    const output = await readFile(serial, "utf8");
    expect(output).toContain("powered-off");
    if (scenario.expected === 0) {
      expect(output).toContain("root-dependencies");
      expect(output).toContain("VECTIS_PREPARED_test");
      expect(output).not.toContain("VECTIS_PREPARATION_FAILED");
      expect(await readFile(join(home, "ownership"), "utf8")).toBe(
        `-R vectis:vectis ${guestHome}/.vectis-runner/${runnerVersion}\n`,
      );
    } else {
      expect(output).toContain(
        `VECTIS_PREPARATION_FAILED_test step=${scenario.shutdownExit ? "poweroff" : scenario.downloadExit ? "runner-download" : "runner-dependencies"} exit=${scenario.expected}`,
      );
      if (!scenario.shutdownExit) expect(output).not.toContain("VECTIS_PREPARED_test");
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

const packageScenarios: {
  name: string;
  failure?: "update" | "base" | "toolchain";
  failures?: number;
  locks?: number;
  attempts?: [number, number, number];
  expected: number;
}[] = [
  { name: "piped noninteractive output", expected: 0 },
  {
    name: "transient update errors",
    failure: "update",
    failures: 2,
    attempts: [3, 1, 1],
    expected: 0,
  },
  {
    name: "transient base install errors",
    failure: "base",
    failures: 2,
    attempts: [1, 3, 1],
    expected: 0,
  },
  {
    name: "transient toolchain install errors",
    failure: "toolchain",
    failures: 2,
    attempts: [1, 1, 3],
    expected: 0,
  },
  {
    name: "exhausted update retries",
    failure: "update",
    failures: 3,
    attempts: [3, 0, 0],
    expected: 100,
  },
  {
    name: "exhausted base install retries",
    failure: "base",
    failures: 3,
    attempts: [1, 3, 0],
    expected: 100,
  },
  {
    name: "exhausted toolchain install retries",
    failure: "toolchain",
    failures: 3,
    attempts: [1, 1, 3],
    expected: 100,
  },
  { name: "busy apt locks clear", locks: 2, expected: 0 },
  { name: "busy apt locks time out", locks: 1000, expected: 100 },
];

test.each(packageScenarios)("Linux package preparation: $name", async (scenario) => {
  const home = await mkdtemp(join(tmpdir(), "vectis-seed-packages-"));
  try {
    const script = preparationScript(home).split("usermod -aG docker vectis\n")[0];
    if (!script) throw new Error("Missing package preparation script");
    const result = spawnSync("/bin/bash", ["-s"], {
      input: `
uname() { echo 'E: earlier initialize output' >&2; echo aarch64; }
sleep() { SECONDS=$((SECONDS + $1)); }
lock_checks=0
fuser() {
  printf '%s\\n' "$*" >> "$FIXTURE_ROOT/lock-checks"
  lock_checks=$((lock_checks + 1))
  test "$lock_checks" -le ${scenario.locks ?? 0}
}
tee() { /bin/sleep 0.05; command tee "$@"; }
poweroff() {
  cmp "$FIXTURE_ROOT/serial.log" "$FIXTURE_ROOT/prepare.log" >/dev/null || test "$completed" = false || return 95
  echo powered-off
}
failed_calls=0
apt-get() {
  test ! -t 0 && test -p /dev/fd/1 && test -p /dev/fd/2 || return 96
  test "$DEBIAN_FRONTEND" = noninteractive || return 97
  printf '%s\\n' "$*" >> "$FIXTURE_ROOT/apt-calls"
  while test "$#" -gt 0; do
    case "$1" in
      -o) shift 2 ;;
      -q) shift ;;
      *) break ;;
    esac
  done
  phase=$1
  if test "$phase" = install; then
    if test "$3" = --no-install-recommends; then phase=toolchain; else phase=base; fi
  fi
  if test "$phase" = '${scenario.failure ?? "none"}'; then
    failed_calls=$((failed_calls + 1))
    if test "$failed_calls" -le ${scenario.failures ?? 0}; then
      for ((line = 1; line <= 45; line++)); do printf 'dependency error detail %s\\n' "$line" >&2; done
      printf 'E: simulated %s failure %s\\n' "$phase" "$failed_calls" >&2
      for ((line = 0; line < 200; line++)); do printf '\\r97%% [Working] Packages store 0 B' >&2; done
      printf '\\n' >&2
      return 100
    fi
  fi
  printf 'completed %s\\n' "$phase"
}
${script}
completed=true
`,
      cwd: home,
      env: { ...process.env, HOME: home, FIXTURE_ROOT: home },
      encoding: "utf8",
      timeout: 10_000,
    });
    const output = await readFile(join(home, "serial.log"), "utf8");
    const log = await readFile(join(home, "prepare.log"), "utf8");
    expect(result.status, result.error?.message ?? output.slice(-4096)).toBe(scenario.expected);
    expect(output).toContain("powered-off");
    const checks = (await readFile(join(home, "lock-checks"), "utf8")).trim().split("\n");
    for (const check of checks)
      expect(check).toBe(
        "/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock",
      );
    if (scenario.locks === 1000) {
      expect(checks).toHaveLength(61);
      const error = "E: Timed out waiting for apt/dpkg locks after 300 seconds.";
      const marker = "VECTIS_PREPARATION_FAILED_test step=packages exit=100";
      expect(output.slice(0, output.indexOf(marker)).split("\n").slice(-3)).toEqual([
        error,
        error,
        "",
      ]);
      await expect(readFile(join(home, "apt-calls"), "utf8")).rejects.toThrow();
    } else {
      const calls = (await readFile(join(home, "apt-calls"), "utf8")).trim().split("\n");
      const options =
        "-q -o Dpkg::Progress-Fancy=0 -o APT::Color=0 -o Dpkg::Use-Pty=0 -o DPkg::Lock::Timeout=300 -o APT::Update::Error-Mode=any ";
      for (const call of calls) expect(call.startsWith(options)).toBe(true);
      const commands = calls.map((call) => call.slice(options.length));
      const update = commands.filter((call) => call === "update");
      const base = commands.filter(
        (call) => call === "install -y curl git openssh-server docker.io",
      );
      const toolchain = commands.filter((call) =>
        call.startsWith("install -y --no-install-recommends "),
      );
      expect([update.length, base.length, toolchain.length]).toEqual(
        scenario.attempts ?? [1, 1, 1],
      );
      expect(update.length + base.length + toolchain.length).toBe(calls.length);
      expect(checks).toHaveLength(calls.length + (scenario.locks ?? 0));
      if (scenario.expected) {
        const marker = "VECTIS_PREPARATION_FAILED_test step=packages exit=100";
        const beforeMarker = output.slice(0, output.indexOf(marker));
        const replay = beforeMarker.trimEnd().split("\n").slice(-40);
        expect(beforeMarker.slice(-4096)).toContain(`E: simulated ${scenario.failure} failure 3`);
        expect(replay).toHaveLength(40);
        expect(replay[0]).toBe("dependency error detail 7");
        expect(replay.at(-1)).toBe(`E: simulated ${scenario.failure} failure 3`);
        expect(replay.join("\n")).not.toMatch(/97%|earlier initialize/);
        expect(log).toContain("97% [Working] Packages store 0 B");
      }
    }
    if (scenario.expected) {
      expect(output).toContain("VECTIS_PREPARATION_FAILED_test step=packages exit=100");
    } else {
      expect(output).not.toContain("VECTIS_PREPARATION_FAILED");
      expect(output).toBe(`${log}powered-off\n`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

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
