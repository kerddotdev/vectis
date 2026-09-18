import { expect, test } from "vitest";
import { addressFromLeases, addressFromNeighbors } from "./guest-address.js";

const lease = (mac: string, ip: string) =>
  `{\n name=guest\n ip_address=${ip}\n hw_address=1,${mac}\n}`;
test("selects only the helper-owned MAC and accepts macOS unpadded lease bytes", () => {
  const source = lease("a2:ff:3:4:5:6", "192.168.64.2") + lease("2:0:0:0:0:1", "192.168.64.3");
  expect(addressFromLeases(source, "02:00:00:00:00:01")).toBe("192.168.64.3");
  expect(addressFromLeases(source, "02:00:00:00:00:02")).toBeUndefined();
});
test("rejects ambiguity and ignores malformed lease addresses", () => {
  const mac = "02:00:00:00:00:01";
  expect(() =>
    addressFromLeases(lease(mac, "192.168.64.2") + lease(mac, "192.168.64.3"), mac),
  ).toThrow("Multiple addresses");
  expect(addressFromLeases(lease(mac, "--option"), mac)).toBeUndefined();
  expect(() => addressFromLeases("", "invalid")).toThrow("invalid");
});

test("matches owned bridged neighbors when DHCP records use a DUID instead of a MAC", () => {
  const mac = "3e:53:b6:23:e4:7b";
  const duid = "{\n ip_address=192.168.64.25\n hw_address=ff,f1:f5:dd:7f:0:2:0:0:ab:11\n}";
  expect(addressFromLeases(duid, mac)).toBeUndefined();
  const neighbors =
    "? (192.168.64.25) at 3e:53:b6:23:e4:7b on bridge103 ifscope [bridge]\n? (192.168.64.26) at 2:0:0:0:0:1 on bridge103 ifscope [bridge]";
  expect(addressFromNeighbors(neighbors, mac)).toBe("192.168.64.25");
  expect(addressFromNeighbors(neighbors, "02:00:00:00:00:01")).toBe("192.168.64.26");
  expect(addressFromNeighbors(neighbors, "02:00:00:00:00:02")).toBeUndefined();
});
test("rejects conflicting neighbors and ignores non-bridge or incomplete entries", () => {
  const mac = "02:00:00:00:00:01";
  const row = (ip: string, network = "bridge103", hardware = mac) =>
    `? (${ip}) at ${hardware} on ${network} ifscope\n`;
  expect(() => addressFromNeighbors(row("192.168.64.2") + row("192.168.64.3"), mac)).toThrow(
    "Multiple addresses",
  );
  expect(
    addressFromNeighbors(
      row("192.168.64.2", "en0") + row("192.168.64.3", "bridge103", "(incomplete)"),
      mac,
    ),
  ).toBeUndefined();
  expect(addressFromNeighbors(row("--option"), mac)).toBeUndefined();
});
