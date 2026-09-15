import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { verifyWebhook } from "./webhook.js";

test("authenticates exact webhook bytes and rejects payload changes", async () => {
  const secret = "isolated-test-secret";
  const body = new TextEncoder().encode('{"action":"queued"}');
  const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  expect(await verifyWebhook(secret, body, signature)).toBe(true);
  expect(
    await verifyWebhook(secret, new TextEncoder().encode('{"action": "queued"}'), signature),
  ).toBe(false);
  expect(await verifyWebhook("different", body, signature)).toBe(false);
  expect(await verifyWebhook(secret, body, "sha256=invalid")).toBe(false);
  expect(await verifyWebhook(secret, body, null)).toBe(false);
});
