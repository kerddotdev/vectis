import { expect, it } from "vitest";
import { env, seedAccount, seedBinding, seedMachine } from "../src/test-support.js";
import { sweepRetention } from "../src/retention.js";
it("expires transient rows and retains active operations past the history window", async () => {
  const m = await seedMachine();
  const now = Date.now(),
    old = now - 100 * 86400000;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO pairings VALUES ('digest', ?, ?, ?)").bind(m.owner, m.id, now - 1),
    env.DB.prepare(
      "INSERT INTO operations (id, owner, machineId, key, commandJson, phase, createdAt, updatedAt) VALUES ('active', ?, ?, 'active', '{}', 'running', ?, ?), ('done', ?, ?, 'done', '{}', 'succeeded', ?, ?)",
    ).bind(m.owner, m.id, old, old, m.owner, m.id, old, old),
  ]);
  await sweepRetention(env, now);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM pairings").first("n")).toBe(0);
  expect((await env.DB.prepare("SELECT id FROM operations").all()).results).toEqual([
    { id: "active" },
  ]);
});

it("keeps sweeping full batches until the backlog is cleared", async () => {
  const now = Date.now(),
    old = now - 40 * 86400000;
  await env.DB.batch(
    Array.from({ length: 1201 }, (_, index) =>
      env.DB.prepare(
        "INSERT INTO githubDeliveries (deliveryId, event, receivedAt) VALUES (?, 'workflow_job', ?)",
      ).bind(`old-${index}`, old),
    ),
  );
  await sweepRetention(env, now);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM githubDeliveries").first("n")).toBe(0);
});

it("expires runner demands with the same window as their jobs", async () => {
  const m = await seedMachine();
  const account = await seedAccount(m.owner);
  const binding = await seedBinding({ owner: m.owner, accountId: account.id, machineId: m.id });
  const now = Date.now();
  const demand = env.DB.prepare(
    "INSERT INTO runnerDemands (installationId, repositoryId, jobId, owner, bindingId, operationId, attempt, updatedAt) VALUES (10, 1000, ?, ?, ?, ?, 1, ?)",
  );
  await env.DB.batch([
    demand.bind(1, m.owner, binding.id, "old", now - 91 * 86400000),
    demand.bind(2, m.owner, binding.id, "recent", now - 89 * 86400000),
  ]);
  await sweepRetention(env, now);
  expect((await env.DB.prepare("SELECT jobId FROM runnerDemands").all()).results).toEqual([
    { jobId: 2 },
  ]);
});
