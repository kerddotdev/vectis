import { runnerDistribution } from "./runner-release.js";
import { VectisError } from "../../protocol/src/index.js";

export const ubuntuImage = {
  revision: "ubuntu-24.04-arm64-20260911",
  url: "https://cloud-images.ubuntu.com/releases/noble/release-20260911/ubuntu-24.04-server-cloudimg-arm64.tar.gz",
  sha256: "82d61182744e8a4f3d388a1965208abb351daa47a689c49165bfb0c41471af35",
  bytes: 535880744,
  disk: "noble-server-cloudimg-arm64.img",
};
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
dpkg-query -W curl git openssh-server docker.io > /etc/vectis/toolchain-versions.txt
printf '${ubuntuImage.revision}\\n' > /etc/vectis/image-revision
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
