import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { beginPairing, disconnectPairing, finishPairing } from "./pairing.js";
import { startService } from "../../../apps/server/src/http.js";

const cloud = { cloudUrl: "https://pairing-test.example.com", webUrl: "https://vectis.test" };
afterEach(() => vi.unstubAllGlobals());
test("pairing retries preserve the local secret and approval links never contain raw credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-pair-client-"));
  const service = await startService({ home });
  const stored = new Map<string, string>();
  const credentials = {
    get: async (account: string) => stored.get(account) ?? null,
    set: async (account: string, value: string) => {
      stored.set(account, value);
    },
    remove: async (account: string) => {
      stored.delete(account);
    },
  };
  try {
    const request = await beginPairing(home, cloud, credentials);
    expect(await beginPairing(home, cloud, credentials)).toEqual(request);
    expect(stored.size).toBe(1);
    const packed = Array.from(stored.values())[0];
    expect(packed).toBeDefined();
    const secrets: { request: string; credential: string } = JSON.parse(packed ?? "null");
    const decodedLink = decodeURIComponent(request.url);
    expect(decodedLink).not.toContain(secrets.request);
    expect(decodedLink).not.toContain(secrets.credential);
    const descriptor: { localId: string } = JSON.parse(
      await readFile(join(home, "pairing.json"), "utf8"),
    );
    const actualFetch = globalThis.fetch;
    let approved = false;
    let revoked = false;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://pairing-test.example.com/machine/pairing")
        return Response.json(
          approved
            ? { machineId: "test-machine", localId: descriptor.localId }
            : { state: "pending" },
        );
      if (url === "https://pairing-test.example.com/machine/sync") {
        if (revoked) return Response.json({ code: "machine_revoked" }, { status: 401 });
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Bearer test-machine.${secrets.credential}`,
        );
        return Response.json({
          operations: [],
          inspections: [],
          repositories: [],
          observations: [],
          jobMarkers: {},
        });
      }
      return actualFetch(input, init);
    });
    expect(await finishPairing(home, credentials)).toEqual({ state: "pending" });
    approved = true;
    const result = await finishPairing(home, credentials);
    expect(result.state).toBe("linked");
    expect((await finishPairing(home, credentials)).state).toBe("linked");
    revoked = true;
    await expect(finishPairing(home, credentials)).rejects.toMatchObject({
      code: "machine_revoked",
    });
    revoked = false;
    expect(stored.size).toBe(1);
    expect(await readFile(join(home, "cloud.json"), "utf8")).not.toContain("test-token");
    expect(service.store.snapshot().machine.id).toBe(descriptor.localId);
    await expect(readFile(join(home, "pairing.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await disconnectPairing(home, credentials)).toMatchObject({ state: "disconnected" });
    expect(stored.size).toBe(0);
    await expect(readFile(join(home, "cloud.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(disconnectPairing(home, credentials)).rejects.toMatchObject({
      code: "cloud_unconfigured",
    });
    expect((await beginPairing(home, cloud, credentials)).state).toBe("action_required");
  } finally {
    await service.close();
    await rm(home, { recursive: true, force: true });
  }
});
