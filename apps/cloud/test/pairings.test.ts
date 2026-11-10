import { afterEach, expect, it, vi } from "vitest";
import {
  env,
  humanRequest,
  machineRequest,
  SELF,
  seedMachine,
  secret,
  stubFetch,
} from "../src/test-support.js";
import { sha256Hex } from "../src/ids.js";
afterEach(() => vi.restoreAllMocks());
it("re-pairs a Mac in place and revokes the previous bearer", async () => {
  stubFetch();
  const machine = await seedMachine({ localId: "mac" });
  const credential = secret(),
    request = secret();
  const input = {
    requestDigest: await sha256Hex(request),
    credentialDigest: await sha256Hex(credential),
    localId: "mac",
    name: "Recovered Mac",
    expiresAt: Date.now() + 60000,
  };
  const response = await humanRequest("/pairings/approve", input);
  expect(await response.json()).toEqual({ machineId: machine.id });
  expect((await humanRequest("/pairings/approve", input)).status).toBe(200);
  expect((await machineRequest("/machine/github/accounts", machine.bearer)).status).toBe(401);
  expect(
    (await machineRequest("/machine/github/accounts", `${machine.id}.${credential}`)).status,
  ).toBe(200);
  const resolved = await SELF.fetch("https://cloud.test/machine/pairing", {
    method: "POST",
    body: JSON.stringify({ secret: request }),
  });
  expect(resolved.headers.get("Cache-Control")).toBe("no-store");
  expect(await resolved.json()).toEqual({ machineId: machine.id, localId: "mac" });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM machines").first("n")).toBe(1);
});
it("rejects reused requests with different credentials and expired approvals", async () => {
  stubFetch();
  const input = {
    requestDigest: "a".repeat(64),
    credentialDigest: "b".repeat(64),
    localId: "mac",
    name: "Mac",
    expiresAt: Date.now() + 60000,
  };
  expect((await humanRequest("/pairings/approve", input)).status).toBe(200);
  expect(
    await (
      await humanRequest("/pairings/approve", { ...input, credentialDigest: "c".repeat(64) })
    ).json(),
  ).toMatchObject({ code: "pairing_conflict" });
  expect(
    await (await humanRequest("/pairings/approve", { ...input, expiresAt: Date.now() - 1 })).json(),
  ).toMatchObject({ code: "invalid_pairing" });
});
it("serializes duplicate approvals without creating extra machines or rotating a conflicting credential", async () => {
  stubFetch();
  const input = {
    requestDigest: "d".repeat(64),
    credentialDigest: "e".repeat(64),
    localId: "racing-mac",
    name: "Mac",
    expiresAt: Date.now() + 60000,
  };
  const responses = await Promise.all([
    humanRequest("/pairings/approve", input),
    humanRequest("/pairings/approve", input),
  ]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  expect(await responses[0]?.json()).toEqual(await responses[1]?.json());
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM machines WHERE localId = 'racing-mac'").first(
      "n",
    ),
  ).toBe(1);
});
