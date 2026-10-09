import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const run = promisify(execFile);
test.skipIf(process.platform === "win32")(
  "the compiled QEMU filter blocks host destinations while preserving DNS, DHCP, public egress and SSH replies",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "vectis-network-"));
    try {
      const patch = await readFile(
        new URL(
          "../../../native/qemu/patches/0002-isolate-vectis-user-network.patch",
          import.meta.url,
        ),
        "utf8",
      );
      const section = patch.split("+++ b/net/vectis-isolation.h\n")[1]!.split("--- a/")[0]!;
      const header = section
        .split("\n")
        .filter((line) => line.startsWith("+"))
        .map((line) => line.slice(1))
        .join("\n");
      await writeFile(join(root, "vectis-isolation.h"), header);
      await writeFile(
        join(root, "test.c"),
        `#include <stdio.h>
#include <stdlib.h>
#include <arpa/inet.h>
#include "vectis-isolation.h"
static bool interfaces_unavailable;
int getifaddrs(struct ifaddrs **interfaces) {
    static struct sockaddr_in address;
    static struct ifaddrs interface;
    if (interfaces_unavailable) return -1;
    address.sin_family = AF_INET;
    inet_pton(AF_INET, "198.51.100.7", &address.sin_addr);
    interface.ifa_addr = (struct sockaddr *)&address;
    *interfaces = &interface;
    return 0;
}
void freeifaddrs(struct ifaddrs *interfaces) { (void)interfaces; }
int main(int argc, char **argv) {
    uint8_t frame[54] = {0};
    struct in_addr destination;
    if (argc != 8 || inet_pton(AF_INET, argv[1], &destination) != 1) return 2;
    interfaces_unavailable = atoi(argv[7]);
    frame[12] = 8; frame[14] = 0x45; frame[17] = 40;
    frame[23] = atoi(argv[2]);
    memcpy(frame + 30, &destination, 4);
    unsigned source = atoi(argv[3]), target = atoi(argv[4]);
    frame[34] = source >> 8; frame[35] = source;
    frame[36] = target >> 8; frame[37] = target;
    frame[47] = atoi(argv[5]); frame[21] = atoi(argv[6]);
    printf("%d", vectis_packet_allowed(frame, sizeof(frame)));
    return 0;
}
`,
      );
      const binary = join(root, "filter-test");
      await run("cc", [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        join(root, "test.c"),
        "-o",
        binary,
      ]);
      const allowed = async (
        address: string,
        protocol = 6,
        source = 12345,
        target = 443,
        flags = 2,
        fragment = 0,
        interfacesUnavailable = false,
      ) =>
        (
          await run(binary, [
            address,
            String(protocol),
            String(source),
            String(target),
            String(flags),
            String(fragment),
            interfacesUnavailable ? "1" : "0",
          ])
        ).stdout === "1";
      for (const address of [
        "0.0.0.0",
        "10.0.2.2",
        "10.1.2.3",
        "100.64.1.2",
        "127.0.0.1",
        "127.1.2.3",
        "169.254.169.254",
        "172.16.1.1",
        "172.31.255.255",
        "192.168.1.1",
        "198.18.0.1",
        "224.0.0.1",
        "255.255.255.255",
      ])
        expect(await allowed(address), address).toBe(false);
      for (const address of ["1.1.1.1", "8.8.8.8", "140.82.112.1", "192.0.78.1", "172.32.0.1"])
        expect(await allowed(address), address).toBe(true);
      expect(await allowed("198.51.100.7")).toBe(false);
      expect(await allowed("1.1.1.1", 6, 12345, 443, 2, 0, true)).toBe(false);
      expect(await allowed("10.0.2.3", 17, 12345, 53)).toBe(true);
      expect(await allowed("10.0.2.3", 6, 12345, 53)).toBe(true);
      expect(await allowed("10.0.2.3", 17, 12345, 22)).toBe(false);
      expect(await allowed("10.0.2.3", 17, 12345, 53, 0, 1)).toBe(false);
      expect(await allowed("255.255.255.255", 17, 68, 67)).toBe(true);
      expect(await allowed("10.0.2.2", 6, 22, 51000, 18)).toBe(true);
      expect(await allowed("10.0.2.2", 6, 22, 51000, 16)).toBe(true);
      expect(await allowed("10.0.2.2", 6, 22, 51000, 2)).toBe(false);
      expect(await allowed("10.0.2.2", 6, 12345, 80, 18)).toBe(false);
      expect(await allowed("127.0.0.1", 6, 22, 80, 18)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
