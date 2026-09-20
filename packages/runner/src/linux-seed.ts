import { runnerDistribution } from "./runner-release.js";
import { VectisError } from "../../protocol/src/index.js";

export const ubuntuImage = {
  revision: "ubuntu-24.04-arm64-20260911",
  url: "https://cloud-images.ubuntu.com/releases/noble/release-20260911/ubuntu-24.04-server-cloudimg-arm64.img",
  sha256: "7b682958a67ff5de068e36de6af8b75fa645d296af5a70d6500527f6a33781db",
  bytes: 619621888,
};
// GitHub's own ARM64 Ubuntu image decides what a hosted runner guarantees a workflow, and its
// definition is public: images/ubuntu/toolsets/toolset-2404-arm64.json in actions/runner-images,
// MIT. These are its three apt lists, which is the layer a prepared guest has to match. The rest
// of that image, the languages, databases, browsers and cloud tools, stays out: setup actions
// download those at job time, and a disposable local VM should not carry them.
const runnerPackages = [
  // vital_packages
  "bzip2 curl g++ gcc make jq tar unzip wget",
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

export function linuxSeed(input: {
  id: string;
  publicKey: string;
  hostPrivateKey: string;
  hostPublicKey: string;
}) {
  if (
    !/^[a-zA-Z0-9-]{1,80}$/.test(input.id) ||
    ![input.publicKey, input.hostPublicKey].every((key) =>
      /^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(key.trim()),
    )
  )
    throw new VectisError(
      "invalid_setup_identity",
      "Expected a generated setup identity and Ed25519 public keys.",
    );
  const runner = runnerDistribution("linux");
  const marker = `VECTIS_PREPARED_${input.id}`;
  const network =
    'network: {version: 2, ethernets: {vectis: {match: {name: "e*"}, dhcp4: true, dhcp-identifier: mac}}}\n';
  const script = `#!/bin/bash
set -euo pipefail
trap 'poweroff' EXIT
test "$(uname -m)" = aarch64
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl git openssh-server docker.io
apt-get install -y --no-install-recommends ${runnerPackages}
usermod -aG docker vectis
systemctl enable ssh docker
systemctl start docker
mkdir -p /opt/vectis-bootstrap
cd /opt/vectis-bootstrap
curl --fail --location --retry 3 --connect-timeout 15 --max-time 300 -o runner.tgz '${runner.url}'
printf '${runner.sha256}  runner.tgz\\n' | sha256sum -c -
tar xzf runner.tgz
./bin/installdependencies.sh
cd /
rm -rf /opt/vectis-bootstrap
netplan generate
test "$(docker info --format '{{.OSType}}')" = linux
mkdir -p /etc/vectis
dpkg-query -W -f='\${Package}\\t\${Version}\\n' > /etc/vectis/toolchain-versions.txt
printf '${ubuntuImage.revision}\\n' > /etc/vectis/image-revision
# The downloaded archives go, the package lists stay: a job that runs apt-get install should not
# have to run apt-get update first.
apt-get clean
touch /etc/cloud/cloud-init.disabled
printf 'uninitialized\\n' > /etc/machine-id
printf '${marker}\\n' > /dev/hvc0
`;
  return {
    marker,
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
            ssh_authorized_keys: [input.publicKey.trim()],
          },
        ],
        disable_root: true,
        ssh_pwauth: false,
        ssh_keys: {
          ed25519_private: input.hostPrivateKey,
          ed25519_public: input.hostPublicKey.trim(),
        },
        write_files: [
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
