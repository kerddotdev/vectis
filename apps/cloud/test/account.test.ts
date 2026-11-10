import { afterEach, expect, it, vi } from "vitest";
import {
  env,
  humanRequest,
  ownerOf,
  seedMachine,
  seedAccount,
  seedBinding,
  stubFetch,
} from "../src/test-support.js";
import { verifyClerkWebhook } from "../src/account.js";
afterEach(() => vi.restoreAllMocks());
it("purges only the signed-in owner and cascades repository state", async () => {
  stubFetch();
  const own = await seedMachine({ owner: ownerOf() });
  const foreign = await seedMachine({ owner: ownerOf("other") });
  const account = await seedAccount(own.owner);
  await seedBinding({ owner: own.owner, accountId: account.id, machineId: own.id });
  const overview = await humanRequest("/account/overview");
  expect(overview.status).toBe(200);
  expect(await overview.json()).toMatchObject({
    machines: [{ id: own.id }],
    github: { accounts: [{ id: account.id }] },
  });
  expect((await humanRequest("/account/remove", {})).status).toBe(200);
  expect((await env.DB.prepare("SELECT id FROM machines").all()).results).toEqual([
    { id: foreign.id },
  ]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM repositoryBindings").first("n")).toBe(0);
});
it("verifies the exact Svix body and rejects replay outside the time window", async () => {
  const secret = "whsec_" + btoa("test-secret");
  const now = Date.now(),
    timestamp = String(Math.floor(now / 1000));
  const body = new TextEncoder().encode('{"type":"user.deleted","data":{"id":"user_1"}}');
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("test-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`message.${timestamp}.${new TextDecoder().decode(body)}`),
    ),
  );
  const headers = new Headers({
    "svix-id": "message",
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${btoa(String.fromCharCode(...signature))}`,
  });
  expect(await verifyClerkWebhook(secret, headers, body, now)).toBe(true);
  expect(await verifyClerkWebhook(secret, headers, body, now + 301000)).toBe(false);
  expect(await verifyClerkWebhook(secret, headers, new TextEncoder().encode("{}"), now)).toBe(
    false,
  );
});
