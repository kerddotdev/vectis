import { expect, test } from "vitest";
import { windowsVmArguments } from "./windows-arguments.js";

test.each([
  { egress: undefined, isolation: "on" },
  { egress: "internet_only", isolation: "on" },
  { egress: "open", isolation: "off" },
] as const)("Windows $egress egress selects isolation $isolation", ({ egress, isolation }) => {
  const args = windowsVmArguments({
    firmwarePath: "/synthetic/uefi.fd",
    cpu: 1,
    memoryMiB: 512,
    ...(egress === undefined ? {} : { egress }),
  });
  expect(args[args.indexOf("-netdev") + 1]).toBe(
    `user,id=net0,ipv6=off,vectis-isolate=${isolation},hostfwd=tcp:127.0.0.1:0-:22`,
  );
});

test("cache uses a separate raw NVMe disk with a stable guest identity and escaped path", () => {
  const args = windowsVmArguments({
    firmwarePath: "/firmware.fd",
    cpu: 2,
    memoryMiB: 4096,
    cacheDiskPath: "/instance,one/cache.img",
  });
  expect(args).toContain("file=/instance,,one/cache.img,if=none,id=cache,format=raw,cache=unsafe");
  expect(args).toContain("nvme,drive=cache,serial=VECTISCACHE");
  expect(args).toContain("nvme,drive=system,serial=vectis-system,bootindex=0");
});
