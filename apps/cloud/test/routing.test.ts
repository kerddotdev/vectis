import { afterEach, describe, expect, it, vi } from "vitest";
import {
  env,
  humanRequest,
  machineRequest,
  SELF,
  seedMachine,
  stubFetch,
} from "../src/test-support.js";

afterEach(() => vi.restoreAllMocks());

describe("routing and authentication", () => {
  it("answers unknown routes with a typed 404", async () => {
    const response = await SELF.fetch("https://cloud.test/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "not_found" });
  });

  it("refuses machine routes without a valid credential", async () => {
    const machine = await seedMachine();
    const missing = await SELF.fetch("https://cloud.test/machine/sync", {
      method: "POST",
      body: "{}",
    });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ code: "machine_unauthorized" });
    const wrong = await machineRequest("/machine/sync", `${machine.id}.${"x".repeat(43)}`, {
      leaseIds: [],
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ code: "machine_revoked" });
  });

  it("decodes machine bodies against the protocol before any handler runs", async () => {
    const machine = await seedMachine();
    const invalid = await machineRequest("/machine/sync", machine.bearer, { leaseIds: "x" });
    expect(invalid.status).toBe(400);
    const extra = await machineRequest("/machine/sync", machine.bearer, { leaseIds: [], x: 1 });
    expect(extra.status).toBe(400);
  });

  it("authenticates socket upgrades through the subprotocol", async () => {
    const machine = await seedMachine();
    const anonymous = await SELF.fetch("https://cloud.test/machine/socket", {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "vectis.v1" },
    });
    expect(anonymous.status).toBe(401);
    const encoded = btoa(machine.bearer)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    const forged = btoa(`${machine.id}.${"y".repeat(43)}`).replace(/=+$/, "");
    const refused = await SELF.fetch("https://cloud.test/machine/socket", {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `vectis.v1, auth.${forged}` },
    });
    expect(refused.status).toBe(401);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("verifies Clerk session tokens and the web origin for human routes", async () => {
    stubFetch();
    const anonymous = await SELF.fetch("https://cloud.test/account/overview", {
      headers: { Origin: env.VECTIS_WEB_URL },
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("Access-Control-Allow-Origin")).toBe(env.VECTIS_WEB_URL);
    const foreign = await SELF.fetch("https://cloud.test/account/overview", {
      headers: { Origin: "https://evil.test" },
    });
    expect(foreign.status).toBe(403);
    const preflight = await SELF.fetch("https://cloud.test/pairings/approve", {
      method: "OPTIONS",
      headers: { Origin: env.VECTIS_WEB_URL },
    });
    expect(preflight.status).toBe(204);
    const signedIn = await humanRequest("/account/overview");
    expect(signedIn.status).not.toBe(401);
  });
});
