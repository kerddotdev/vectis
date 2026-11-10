import { afterEach, expect, it, vi } from "vitest";
import {
  env,
  seedMachine,
  seedAccount,
  seedBinding,
  machineRequest,
  readyLinux,
} from "../src/test-support.js";
import { machineRecord, type MachineRow } from "../src/db.js";
import { machineRepositories } from "../src/github/repositories.js";
afterEach(() => vi.restoreAllMocks());
it("keeps machine repositories ordered, enabled and owned; rejects foreign updates", async () => {
  const m = await seedMachine({ environments: [readyLinux()] });
  const other = await seedMachine({ owner: "other" });
  const a = await seedAccount(m.owner);
  const first = await seedBinding({ owner: m.owner, accountId: a.id, machineId: m.id });
  await seedBinding({
    owner: m.owner,
    accountId: a.id,
    machineId: m.id,
    repositoryId: 2000,
    enabled: false,
  });
  const row = await env.DB.prepare("SELECT * FROM machines WHERE id = ?")
    .bind(m.id)
    .first<MachineRow>();
  expect(row).not.toBeNull();
  if (!row) return;
  expect(await machineRepositories(env, machineRecord(row))).toMatchObject([
    { id: first.id, repositoryName: "octo/repo" },
  ]);
  expect(
    (
      await machineRequest("/machine/repositories/set-automatic", other.bearer, {
        bindingId: first.id,
        enabled: true,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await machineRequest("/machine/repositories/set-automatic", m.bearer, {
        bindingId: first.id,
        enabled: true,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await machineRequest("/machine/repositories/set-access", m.bearer, {
        bindingId: first.id,
        actors: { ids: [1, 1] },
        approval: "required",
      })
    ).status,
  ).toBe(200);
  expect(
    await (
      await machineRequest("/machine/repositories/set-capacity-mode", m.bearer, {
        bindingId: first.id,
        capacityMode: "scale_set",
      })
    ).json(),
  ).toMatchObject({ code: "scale_set_policy_unsupported" });
});
it("rechecks the machine credential after GitHub verification before persisting a binding", async () => {
  const { seedApp, stubFetch } = await import("../src/test-support.js");
  await seedApp();
  const m = await seedMachine({ owner: "connect-owner", environments: [readyLinux()] });
  const a = await seedAccount(m.owner, { githubId: 7, login: "owner" });
  let revoke = false;
  stubFetch(async (request) => {
    const url = new URL(request.url).pathname;
    if (url.endsWith("/installation"))
      return Response.json({
        id: 3,
        app_id: 1,
        account: { id: 7, type: "User" },
        suspended_at: null,
      });
    if (url.endsWith("/access_tokens")) return Response.json({ token: "test-token" });
    if (url.endsWith("/permission")) return Response.json({ permission: "admin", user: { id: 7 } });
    if (url.endsWith("/fork-pr-workflows-private-repos"))
      return Response.json({
        run_workflows_from_fork_pull_requests: false,
        require_approval_for_fork_pr_workflows: false,
      });
    if (revoke)
      await env.DB.prepare("UPDATE machineCredentials SET digest = ? WHERE machineId = ?")
        .bind("f".repeat(64), m.id)
        .run();
    return Response.json({ id: 55, private: true, owner: { id: 7 } });
  });
  const input = { accountId: a.id, repositoryName: "sandbox", environmentId: "linux" };
  const first = await machineRequest("/machine/repositories/connect", m.bearer, input);
  expect(first.status).toBe(200);
  expect(
    await (await machineRequest("/machine/repositories/connect", m.bearer, input)).json(),
  ).toEqual(await first.json());
  revoke = true;
  const refused = await machineRequest("/machine/repositories/connect", m.bearer, {
    ...input,
    environmentId: "linux",
    repositoryName: "different",
  });
  expect(refused.status).toBe(401);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM repositoryBindings WHERE machineId = ?")
      .bind(m.id)
      .first("n"),
  ).toBe(1);
});
