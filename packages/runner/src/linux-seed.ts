import { runnerPreinstallScript } from "./provision-scripts.js";
import { preinstalledRunnerDirectory } from "./runner-release.js";
import { VectisError } from "../../protocol/src/index.js";

const minimumCaCertificatesVersion = "20260816ubuntu0.24.04.1";

export const ubuntuImage = {
  revision: "ubuntu-24.04-arm64-20261017",
  url: "https://cloud-images.ubuntu.com/releases/noble/release-20261017/ubuntu-24.04-server-cloudimg-arm64.img",
  sha256: "50e24e1fb79e89116e939d90aa7738f7af48c442fa1bc2510131e0b39c50348e",
  bytes: 616522752,
};
// GitHub's own ARM64 Ubuntu image decides what a hosted runner guarantees a workflow, and its
// definition is public: images/ubuntu/toolsets/toolset-2404-arm64.json in actions/runner-images,
// MIT. These are its three apt lists, which is the layer a prepared guest has to match. The rest
// of that image, the languages, databases, browsers and cloud tools, stays out: setup actions
// download those at job time, and a disposable local VM should not carry them.
const runnerPackages = [
  // vital_packages
  "bzip2 curl g++ gcc make jq tar unzip wget zstd",
  // common_packages, without p7zip-rar, which is multiverse and non-free.
  "autoconf automake dbus dnsutils dpkg-dev fakeroot fonts-noto-color-emoji gnupg2 iproute2",
  "iputils-ping libyaml-dev libtool libssl-dev libicu-dev libgbm-dev libsqlite3-dev locales",
  "mercurial openssh-client pkg-config python-is-python3 rpm texinfo tk tree tzdata xvfb xz-utils",
  "zsync",
  // cmd_packages. netcat and upx name virtual packages that apt refuses to resolve on noble, so
  // their providers are installed directly.
  "acl aria2 binutils bison brotli libnss3-tools coreutils file findutils flex ftp haveged lz4 m4",
  "mediainfo netcat-openbsd net-tools p7zip-full parallel patchelf pigz pollinate rsync shellcheck",
  "sphinxsearch sqlite3 ssh sshpass sudo systemd-coredump swig telnet time upx-ucl zip",
  // g++ pulls in libatomic1, but a job that could not start pnpm without it is why this list
  // exists at all, so it stays named.
  "libatomic1",
].join(" ");

export function linuxSeed(input: { id: string; publicKey: string }) {
  if (
    !/^[a-zA-Z0-9-]{1,80}$/.test(input.id) ||
    ![input.publicKey].every((key) =>
      /^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(key.trim()),
    )
  )
    throw new VectisError(
      "invalid_setup_identity",
      "Expected a generated setup identity and Ed25519 public keys.",
    );
  const marker = `VECTIS_PREPARED_${input.id}`;
  const failureMarker = `VECTIS_PREPARATION_FAILED_${input.id}`;
  const network =
    'network: {version: 2, ethernets: {vectis: {match: {name: "e*"}, dhcp4: true, dhcp-identifier: mac}}}\n';
  const script = `#!/bin/bash
set -euo pipefail
step=initialize
completed=false
log=/var/log/vectis-prepare.log
exec 3> /dev/hvc0
finish() {
  status=$?
  trap - EXIT
  exec 1>&3 2>&3
  # Close the pipe and drain tee before replaying errors or shutting down.
  if test -n "\${log_pid:-}"; then wait "$log_pid" || true; fi
  if test -n "\${pipe_dir:-}"; then
    rm -f "$pipe_dir/output"
    rmdir "$pipe_dir"
  fi
  if test "$status" -ne 0 || test "$completed" != true; then
    if test -f "$log"; then
      tr '\\r' '\\n' < "$log" | awk -v current="vectis-prepare: step=$step" '
        /^vectis-prepare: step=/ { active = ($0 == current); next }
        active && NF && $0 !~ /^[[:space:]]*([0-9]+%|Progress:|Packages store )/ { print }
      ' | tail -n 40 || true
    fi
    printf '${failureMarker} step=%s exit=%s\\n' "$step" "$status"
  fi
  poweroff || {
    status=$?
    printf '${failureMarker} step=poweroff exit=%s\\n' "$status"
  }
  exit "$status"
}
trap finish EXIT
: > "$log"
pipe_dir=$(mktemp -d)
mkfifo "$pipe_dir/output"
tee -a "$log" < "$pipe_dir/output" >&3 &
log_pid=$!
exec > "$pipe_dir/output" 2>&1
begin_step() {
  step=$1
  printf 'vectis-prepare: step=%s\\n' "$step"
}
wait_for_apt() {
  local deadline=$((SECONDS + 300))
  while fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock >/dev/null 2>&1; do
    if test "$SECONDS" -ge "$deadline"; then
      printf 'E: Timed out waiting for apt/dpkg locks after 300 seconds.\\n' >&2
      return 100
    fi
    sleep 5
  done
}
apt_get() {
  local attempt status
  for attempt in 1 2 3; do
    wait_for_apt || return $?
    if apt-get -q -o Dpkg::Progress-Fancy=0 -o APT::Color=0 -o Dpkg::Use-Pty=0 -o DPkg::Lock::Timeout=300 -o APT::Update::Error-Mode=any "$@" </dev/null; then
      return 0
    else
      status=$?
    fi
    if test "$attempt" -eq 3; then return "$status"; fi
    printf 'Retrying apt-get %s after exit %s (attempt %s/3).\\n' "$1" "$status" "$attempt" >&2
    sleep 5
  done
}
begin_step initialize
test "$(uname -m)" = aarch64
export DEBIAN_FRONTEND=noninteractive
begin_step packages
apt_get update
apt_get install -y ca-certificates curl git openssh-server docker.io
apt_get install -y --no-install-recommends ${runnerPackages}
usermod -aG docker vectis
systemctl enable ssh docker
systemctl start docker
begin_step trust-store
if ! dpkg --compare-versions "$(dpkg-query -W -f='\${Version}' ca-certificates)" ge ${minimumCaCertificatesVersion}; then
  printf 'E: ca-certificates ${minimumCaCertificatesVersion} or newer is required to distrust compromised eMudhra certificate chains.\\n' >&2
  exit 1
fi
begin_step runner-download
runuser -l vectis -c 'bash -s' <<'VECTIS_RUNNER'
${runnerPreinstallScript("linux", { dependencies: false })}VECTIS_RUNNER
begin_step runner-dependencies
guest_home=$(getent passwd vectis | cut -d: -f6)
test -n "$guest_home"
runner_target="${preinstalledRunnerDirectory("linux").replace("$HOME", "$guest_home")}"
"$runner_target/bin/installdependencies.sh"
chown -R vectis:vectis "$runner_target"
begin_step network
netplan generate
test "$(docker info --format '{{.OSType}}')" = linux
begin_step image-metadata
mkdir -p /etc/vectis
dpkg-query -W -f='\${Package}\\t\${Version}\\n' > /etc/vectis/toolchain-versions.txt
printf '${ubuntuImage.revision}\\n' > /etc/vectis/image-revision
# The downloaded archives go, the package lists stay: a job that runs apt-get install should not
# have to run apt-get update first.
apt_get clean
begin_step boot-services
install -m 0644 /opt/vectis/vectis-rosetta.service /etc/systemd/system/vectis-rosetta.service
systemctl enable vectis-rosetta.service
install -m 0644 /opt/vectis/vectis-instance-identity.service /etc/systemd/system/vectis-instance-identity.service
for unit in ssh.service ssh.socket; do
  mkdir -p "/etc/systemd/system/$unit.d"
  install -m 0644 /opt/vectis/vectis-identity.conf "/etc/systemd/system/$unit.d/vectis-identity.conf"
done
begin_step identity-reset
rm -f /etc/ssh/ssh_host_* /var/lib/cloud/instance/user-data.txt /var/lib/cloud/instance/user-data.txt.i
touch /etc/cloud/cloud-init.disabled
printf 'uninitialized\\n' > /etc/machine-id
printf '${marker}\\n' > /dev/hvc0
completed=true
`;
  return {
    marker,
    failureMarker,
    metadata: `instance-id: ${input.id}\nlocal-hostname: vectis-linux\n`,
    network: JSON.stringify({
      version: 2,
      ethernets: { vectis: { match: { name: "e*" }, dhcp4: true, "dhcp-identifier": "mac" } },
    }),
    userdata:
      "#cloud-config\n" +
      JSON.stringify({
        users: [
          {
            name: "vectis",
            lock_passwd: true,
            shell: "/bin/bash",
            sudo: "ALL=(ALL) NOPASSWD:ALL",
            ssh_authorized_keys: [input.publicKey.trim()],
          },
        ],
        disable_root: true,
        ssh_pwauth: false,
        write_files: [
          {
            path: "/usr/local/sbin/vectis-instance-identity",
            permissions: "0700",
            content: `#!/bin/bash
set -euo pipefail
mkdir -p /run/vectis-identity
mount -o ro,nosuid,nodev,noexec /dev/disk/by-label/VECTISIDENTITY /run/vectis-identity
trap 'umount /run/vectis-identity' EXIT
rm -f /etc/ssh/ssh_host_*
install -m 0600 /run/vectis-identity/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key
install -m 0644 /run/vectis-identity/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ed25519_key.pub
install -m 0644 /run/vectis-identity/instance-id /etc/vectis/instance-id
mkdir -p /run/sshd
/usr/sbin/sshd -t
`,
          },
          {
            path: "/opt/vectis/vectis-instance-identity.service",
            permissions: "0644",
            content: `[Unit]
Description=Install the instance SSH host identity
# SSH socket activation runs before basic.target.
DefaultDependencies=no
Requires=dev-disk-by\\x2dlabel-VECTISIDENTITY.device
After=local-fs.target dev-disk-by\\x2dlabel-VECTISIDENTITY.device
Before=ssh.service ssh.socket shutdown.target
Conflicts=shutdown.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/vectis-instance-identity
RemainAfterExit=yes
`,
          },
          {
            path: "/opt/vectis/vectis-identity.conf",
            permissions: "0644",
            content:
              "[Unit]\nRequires=vectis-instance-identity.service\nAfter=vectis-instance-identity.service\n",
          },
          {
            path: "/usr/local/sbin/vectis-rosetta",
            permissions: "0700",
            content: `#!/bin/bash
set -euo pipefail
test -x /run/rosetta/rosetta
if test -e /proc/sys/fs/binfmt_misc/rosetta; then
  printf '%s\\n' -1 > /proc/sys/fs/binfmt_misc/rosetta
fi
printf '%s\\n' ':rosetta:M::\\x7fELF\\x02\\x01\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x02\\x00\\x3e\\x00:\\xff\\xff\\xff\\xff\\xff\\xfe\\xfe\\x00\\xff\\xff\\xff\\xff\\xff\\xff\\xff\\xff\\xfe\\xff\\xff\\xff:/run/rosetta/rosetta:CF' > /proc/sys/fs/binfmt_misc/register
`,
          },
          {
            path: "/opt/vectis/vectis-rosetta.service",
            permissions: "0644",
            content: `[Unit]
Description=Enable Rosetta for x86_64 Linux binaries
DefaultDependencies=no
Requires=proc-sys-fs-binfmt_misc.mount
Wants=systemd-binfmt.service
After=local-fs.target systemd-udev-trigger.service proc-sys-fs-binfmt_misc.mount systemd-binfmt.service
Before=ssh.service ssh.socket docker.service shutdown.target
Conflicts=shutdown.target
[Service]
Type=oneshot
ExecCondition=/bin/sh -c 'mkdir -p /run/rosetta && mount -t virtiofs -o ro,nosuid,nodev rosetta /run/rosetta'
ExecStart=/usr/local/sbin/vectis-rosetta
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
`,
          },
          { path: "/etc/netplan/50-cloud-init.yaml", permissions: "0600", content: network },
          {
            path: "/opt/vectis/prepare.sh",
            permissions: "0700",
            encoding: "b64",
            content: Buffer.from(script).toString("base64"),
          },
        ],
        runcmd: [["bash", "/opt/vectis/prepare.sh"]],
      }),
  };
}
