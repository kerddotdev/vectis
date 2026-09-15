import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema.js";
import { api } from "../../convex/_generated/api.js";

const modules = {
  "../../convex/_generated/server.js": () => import("../../convex/_generated/server.js"),
  "../../convex/machines.ts": () => import("../../convex/machines.js"),
  "../../convex/operations.ts": () => import("../../convex/operations.js"),
};
beforeEach(() => {
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", "https://clerk.test");
  vi.stubEnv("VECTIS_MACHINE_ISSUER", "https://machines.test");
});
afterEach(() => vi.unstubAllEnvs());
const identity = (subject: string) => ({
  issuer: "https://clerk.test",
  subject,
  tokenIdentifier: `https://clerk.test|${subject}`,
});

test("owners cannot see or control each other's machines", async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("owner"));
  const stranger = t.withIdentity(identity("stranger"));
  const machineId = await owner.mutation(api.machines.enroll, { localId: "host", name: "Host" });
  expect(await stranger.query(api.machines.list, {})).toEqual([]);
  await expect(
    stranger.mutation(api.operations.submit, {
      machineId,
      key: "foreign",
      commandJson: JSON.stringify({ type: "machine.pause", paused: true }),
    }),
  ).rejects.toThrow();
  await expect(t.query(api.machines.list, {})).rejects.toThrow();
});
test("remote commands deduplicate and enforce distinct acknowledgement phases", async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("owner"));
  const machineId = await owner.mutation(api.machines.enroll, { localId: "host", name: "Host" });
  const device = t.withIdentity({ issuer: "https://machines.test", subject: machineId });
  const input = {
    machineId,
    key: "pause",
    commandJson: JSON.stringify({ type: "machine.pause", paused: true }),
  };
  const id = await owner.mutation(api.operations.submit, input);
  expect(await owner.mutation(api.operations.submit, input)).toBe(id);
  await expect(
    owner.mutation(api.operations.submit, {
      ...input,
      commandJson: JSON.stringify({ type: "machine.pause", paused: false }),
    }),
  ).rejects.toThrow();
  await expect(
    device.mutation(api.operations.acknowledge, { id, phase: "succeeded" }),
  ).rejects.toThrow();
  for (const phase of ["claimed", "running", "succeeded"] as const)
    await device.mutation(api.operations.acknowledge, { id, phase });
  await device.mutation(api.operations.acknowledge, { id, phase: "succeeded" });
  expect((await owner.query(api.operations.get, { id })).phase).toBe("succeeded");
  expect(await device.query(api.operations.pending, {})).toEqual([]);
});
test("revocation immediately blocks machine access and human credentials cannot impersonate a machine", async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("owner"));
  const id = await owner.mutation(api.machines.enroll, { localId: "host", name: "Host" });
  const device = t.withIdentity({ issuer: "https://machines.test", subject: id });
  await expect(owner.query(api.operations.pending, {})).rejects.toThrow();
  await device.mutation(api.machines.heartbeat, {});
  await owner.mutation(api.machines.revoke, { id });
  await expect(device.query(api.operations.pending, {})).rejects.toThrow();
});
