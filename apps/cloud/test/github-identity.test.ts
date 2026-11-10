import { expect, it } from "vitest";
import { env, seedApp, seedAccount, ownerOf } from "../src/test-support.js";
import { createLink, claimLink, finishLink, confirmLink } from "../src/github/identity-store.js";
it("claims OAuth state once, binds confirmation to its browser and preserves global GitHub ownership", async () => {
  await seedApp();
  const owner = ownerOf();
  await createLink(env, { owner, digest: "state", verifier: "verifier", browserDigest: "browser" });
  expect(await claimLink(env, { digest: "state", browserDigest: "foreign" })).toBeNull();
  const claim = await claimLink(env, { digest: "state", browserDigest: "browser" });
  expect(claim?.verifier).toBe("verifier");
  expect(await claimLink(env, { digest: "state", browserDigest: "browser" })).toBeNull();
  if (!claim) throw new Error("Missing claim");
  await finishLink(env, {
    id: claim.id,
    user: { id: 100, login: "octo", installations: [] },
    completionDigest: "completion",
  });
  await expect(
    confirmLink(env, {
      id: claim.id,
      owner,
      browserDigest: "foreign",
      completionDigest: "completion",
    }),
  ).rejects.toMatchObject({ code: "github_link_unavailable" });
  await seedAccount("other", { githubId: 100 });
  await expect(
    confirmLink(env, {
      id: claim.id,
      owner,
      browserDigest: "browser",
      completionDigest: "completion",
    }),
  ).rejects.toMatchObject({ code: "github_account_already_linked" });
  expect(
    await env.DB.prepare("SELECT owner FROM githubAccounts WHERE githubId = 100").first("owner"),
  ).toBe("other");
});
