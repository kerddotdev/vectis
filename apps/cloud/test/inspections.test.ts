import { expect, it } from "vitest";
import { env, SELF, seedMachine, machineRequest } from "../src/test-support.js";
import { getInspection, submitInspection } from "../src/inspections.js";

it("requires an online owned machine, deduplicates queries and guards responses and expiry", async () => {
  const machine = await seedMachine();
  const query = { name: "status" } as const;
  await expect(submitInspection(env, machine.owner, machine.id, "q", query)).rejects.toMatchObject({
    code: "machine_offline",
  });
  const response = await SELF.fetch("https://cloud.test/machine/socket", {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `vectis.v1, auth.${btoa(machine.bearer).replace(/=+$/, "")}`,
    },
  });
  const socket = response.webSocket!;
  socket.accept();
  const ids = await Promise.all([
    submitInspection(env, machine.owner, machine.id, "q", query),
    submitInspection(env, machine.owner, machine.id, "q", query),
  ]);
  expect(ids[0]).toEqual(ids[1]);
  const id = ids[0]!.queryId;
  await expect(getInspection(env, "other", id)).rejects.toMatchObject({ code: "query_expired" });
  expect(await getInspection(env, machine.owner, id)).toEqual({
    pending: true,
    responseJson: null,
  });
  expect(
    (
      await machineRequest("/machine/inspections/respond", machine.bearer, {
        id,
        responseJson: "{}",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await machineRequest("/machine/inspections/respond", machine.bearer, {
        id,
        responseJson: "{}",
      })
    ).status,
  ).toBe(200);
  expect(
    await (
      await machineRequest("/machine/inspections/respond", machine.bearer, {
        id,
        responseJson: "different",
      })
    ).json(),
  ).toMatchObject({ code: "query_response_conflict" });
  await env.DB.prepare("UPDATE inspections SET expiresAt = 0 WHERE id = ?").bind(id).run();
  await expect(getInspection(env, machine.owner, id)).rejects.toMatchObject({
    code: "query_expired",
  });
  socket.close();
});
