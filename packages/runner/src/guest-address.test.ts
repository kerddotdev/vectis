import { expect, test } from "vitest";
import { addressFromLeases } from "./guest-address.js";

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
