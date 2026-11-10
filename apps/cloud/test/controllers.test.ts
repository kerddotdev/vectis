import { afterEach, expect, it, vi } from "vitest";
import { humanRequest, SELF, secret, stubFetch } from "../src/test-support.js";
import { sha256Hex } from "../src/ids.js";
afterEach(() => vi.restoreAllMocks());
it("approves idempotently and immediately revokes controller authority", async () => {
  stubFetch();
  const credential = secret();
  const input = {
    requestDigest: "a".repeat(64),
    credentialDigest: await sha256Hex(credential),
    name: "CLI",
    expiresAt: Date.now() + 60000,
  };
  const response = await humanRequest("/controllers/approve", input);
  const body = (await response.json()) as { controllerId: string };
  expect(response.status).toBe(200);
  expect(await (await humanRequest("/controllers/approve", input)).json()).toEqual(body);
  const call = (input: unknown) =>
    SELF.fetch("https://cloud.test/controller/request", {
      method: "POST",
      headers: { Authorization: `Bearer ${body.controllerId}.${credential}` },
      body: JSON.stringify(input),
    });
  expect(await (await call({ type: "machines.list" })).json()).toEqual([]);
  expect((await call({ type: "machines.list", extra: true })).status).toBe(409);
  expect(await (await call({ type: "controller.revoke" })).json()).toEqual({ revoked: true });
  expect((await call({ type: "machines.list" })).status).toBe(401);
});
