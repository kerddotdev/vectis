import { expect, it } from "vitest";
import { env, seedMachine } from "../src/test-support.js";
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
