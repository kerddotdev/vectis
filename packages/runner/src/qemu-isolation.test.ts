import { expect, test, vi, afterEach } from "vitest";
import { runProcess } from "./process.js";
import { verifyQemuIsolation } from "./qemu-isolation.js";
vi.mock("./process.js", () => ({ runProcess: vi.fn() }));
afterEach(() => vi.resetAllMocks());
test("unpatched or incompatible runtimes fail before VM allocation", async () => {
  for (const version of ["", "0", "2", "QEMU 11.1.1"]) {
    vi.mocked(runProcess).mockResolvedValue(version);
    await expect(verifyQemuIsolation("/synthetic/qemu")).rejects.toMatchObject({
      code: "setup_required",
    });
  }
  vi.mocked(runProcess).mockRejectedValue(new Error("Unknown option"));
  await expect(verifyQemuIsolation("/synthetic/qemu")).rejects.toMatchObject({
    code: "setup_required",
  });
  vi.mocked(runProcess).mockResolvedValue("1\n");
  await expect(verifyQemuIsolation("/synthetic/qemu")).resolves.toBeUndefined();
  expect(runProcess).toHaveBeenLastCalledWith(
    "/synthetic/qemu",
    ["-vectis-isolation-version"],
    undefined,
  );
});
