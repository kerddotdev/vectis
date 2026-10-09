import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { instanceIdentity } from "./instance-identity.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
test.skipIf(process.platform !== "darwin")(
  "sibling instances receive distinct pinned host keys through private setup media",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "vectis-identity-"));
    roots.push(root);
    const directories = [join(root, "first"), join(root, "second")];
    for (const directory of directories) await mkdir(directory, { mode: 0o700 });
    const first = await instanceIdentity(directories[0]!, "first");
    const second = await instanceIdentity(directories[1]!, "second");
    const pins = await Promise.all(
      [first, second].map((identity) => readFile(identity.knownHostsPath, "utf8")),
    );
    expect(pins[0]).toMatch(/^first ssh-ed25519 /);
    expect(pins[1]).toMatch(/^second ssh-ed25519 /);
    expect(pins[0]!.split(" ")[2]).not.toBe(pins[1]!.split(" ")[2]);
    const media = await Promise.all([first, second].map((identity) => readFile(identity.seedPath)));
    for (const image of media) {
      expect(image.subarray(0x8028, 0x8048).toString().replaceAll("\0", "").trim()).toBe(
        "VECTISIDENTITY",
      );
      expect(
        Buffer.from(image.subarray(0x8828, 0x8848))
          .swap16()
          .toString("utf16le")
          .replaceAll("\0", "")
          .trim(),
      ).toBe("VECTISIDENTITY");
    }
    expect(media[0]!.includes(Buffer.from(pins[0]!.split(" ").slice(1).join(" ").trim()))).toBe(
      true,
    );
    expect(media[0]!.includes(Buffer.from(pins[1]!.split(" ").slice(1).join(" ").trim()))).toBe(
      false,
    );
    expect(media[1]!.includes(Buffer.from(pins[0]!.split(" ").slice(1).join(" ").trim()))).toBe(
      false,
    );
    for (const directory of directories)
      await expect(readFile(join(directory, "identity/ssh_host_ed25519_key"))).rejects.toThrow();
  },
);
