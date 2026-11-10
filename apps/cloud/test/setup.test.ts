import { expect, it } from "vitest";
import { env, SELF } from "../src/test-support.js";
import { createExecutionContext } from "cloudflare:test";
import { appSetup } from "../src/github/setup.js";
import { sha256Hex } from "../src/ids.js";
it("rejects expired setup state and builds a manifest with the direct Worker webhook", async () => {
  const state = "a".repeat(64);
  await env.DB.prepare(
    "INSERT INTO githubAppSetups (stateDigest,ownerId,ownerLogin,organization,expiresAt) VALUES (?,1,'octo',0,?)",
  )
    .bind(await sha256Hex(state), Date.now() + 60000)
    .run();
  const web = "https://site.invalid";
  const cloud = "https://cloud.invalid";
  const page = await appSetup(
    {
      env: { ...env, VECTIS_WEB_URL: web, VECTIS_CLOUD_URL: cloud },
      ctx: createExecutionContext(),
    },
    new Request(`https://cloud.test/github/app/setup?state=${state}`),
  );
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain(`${cloud}/github/webhook`);
  expect(html).toContain(`${web}/api/github/oauth/callback`);
  await env.DB.prepare("UPDATE githubAppSetups SET consumed = 1").run();
  expect((await SELF.fetch(`https://cloud.test/github/app/setup?state=${state}`)).status).toBe(403);
});
