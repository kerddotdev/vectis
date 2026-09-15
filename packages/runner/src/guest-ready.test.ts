import { expect, test, vi, afterEach } from "vitest";
import { readyGuest, verifyGuestReadiness } from "./guest-ready.js";
import { executeGuest } from "./guest.js";
import { waitForGuestAddress } from "./guest-address.js";

vi.mock("./guest-address.js", () => ({ waitForGuestAddress: vi.fn() }));
vi.mock("./guest.js", async (original) => ({
  ...(await original<typeof import("./guest.js")>()),
  executeGuest: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const environment = {
  id: "test",
  name: "Test",
  os: "linux" as const,
  state: "ready" as const,
  basePath: "/test/base",
  cpu: 1,
  memoryMiB: 512,
  sshHost: "203.0.113.1",
  sshPort: 2222,
  sshUser: "vectis",
  sshKeyPath: "/test/key",
  knownHostsPath: "/test/known_hosts",
};
const instance = {
  id: "instance",
  environmentId: "test",
  status: "running" as const,
  pid: 1,
  createdAt: new Date().toISOString(),
  macAddress: "02:00:00:00:00:01",
};
test("rejects incompatible architecture, malformed output and clock skew", () => {
  verifyGuestReadiness("aarch64 1000", 1000000);
  verifyGuestReadiness("Arm64 1000\r\n", 1000000);
  expect(() => verifyGuestReadiness("x86_64 1000", 1000000)).toThrow("ARM64");
  expect(() => verifyGuestReadiness("arm64 NaN", 1000000)).toThrow("clock");
  expect(() => verifyGuestReadiness("arm64 1000 unexpected", 1000000)).toThrow("ARM64");
  expect(() => verifyGuestReadiness("arm64 1070", 1000000)).toThrow("clock");
});
test("uses the owned MAC address and pinned environment identity instead of configured host overrides", async () => {
  vi.mocked(waitForGuestAddress).mockResolvedValue("192.168.64.8");
  vi.mocked(executeGuest).mockResolvedValue({
    exitCode: 0,
    stdout: `aarch64 ${Math.floor(Date.now() / 1000)}`,
    stderr: "",
    truncated: false,
  });
  const connection = await readyGuest(environment, instance, AbortSignal.timeout(1000));
  expect(connection).toMatchObject({ host: "192.168.64.8", port: 22, hostKeyAlias: "test" });
  expect(waitForGuestAddress).toHaveBeenCalledWith(instance.macAddress, expect.any(AbortSignal));
});
test("rejects foreign instances and Windows forwarding that is not loopback", async () => {
  await expect(
    readyGuest(environment, { ...instance, environmentId: "foreign" }, AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({ code: "guest_not_running" });
  await expect(
    readyGuest(
      { ...environment, os: "windows" },
      {
        ...instance,
        sshHost: "203.0.113.1",
        sshPort: 22,
      },
      AbortSignal.timeout(1000),
    ),
  ).rejects.toMatchObject({ code: "guest_address_unavailable" });
  expect(executeGuest).not.toHaveBeenCalled();
});
