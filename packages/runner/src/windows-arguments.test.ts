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
