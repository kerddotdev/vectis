import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { runProcess } from "./process.js";
import { prepareWindowsMedia } from "./windows-media.js";
import { windowsSeed } from "./windows-seed.js";

vi.mock("./process.js", () => ({ runProcess: vi.fn() }));
afterEach(() => vi.resetAllMocks());

test("setup media includes every isolated Defender script referenced by prepare.ps1", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vectis-windows-media-"));
  try {
    for (const name of ["guest-key", "ssh_host_ed25519_key"])
      for (const suffix of ["", ".pub"])
        await writeFile(join(directory, name + suffix), "synthetic key");
    vi.mocked(runProcess).mockImplementation(async () => {
      await writeFile(join(directory, "setup.iso"), "synthetic iso");
      return "";
    });
    const configuration = {
      id: "windows",
      name: "Windows",
      cpu: 2,
      memoryMiB: 4096,
      diskGiB: 64,
      imageDirectory: directory,
      storagePath: directory,
      isoPath: join(directory, "windows.iso"),
      driversPath: join(directory, "drivers.iso"),
      firmwarePath: join(directory, "code.fd"),
      firmwareVarsPath: join(directory, "vars.fd"),
      imageName: "Windows 11 Pro",
      acceptLicense: true,
    };
    const password = "Generated-local-test-password-42!";
    await prepareWindowsMedia(
      configuration,
      directory,
      "setup-test",
      {
        get: vi.fn().mockResolvedValue(password),
        set: vi.fn(),
      },
      AbortSignal.timeout(10000),
    );
    const seed = windowsSeed({
      id: "setup-test",
      password,
      imageName: configuration.imageName,
      acceptLicense: true,
    });
    const prepare = await readFile(join(directory, "setup-media", "prepare.ps1"), "utf8");
    expect(prepare).toBe(seed.script);
    expect(prepare).not.toMatch(/(?:Add|Set|Get)-Mp/);
    for (const file of seed.defenderScripts) {
      expect(prepare).toContain(file.name);
      expect(await readFile(join(directory, "setup-media", file.name), "utf8")).toBe(file.contents);
    }
    expect(runProcess).toHaveBeenCalledOnce();
    expect(runProcess).toHaveBeenCalledWith(
      "/usr/bin/hdiutil",
      expect.arrayContaining(["makehybrid", join(directory, "setup-media")]),
      expect.anything(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
