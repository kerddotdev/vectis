import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startService } from "../../../apps/server/src/http.js";
import { VectisClient } from "./index.js";
import { answerInspection } from "./inspection.js";

test("inspection uses the authenticated local contract and reports unavailable cloud prerequisites", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-inspection-"));
  const server = await startService({ home });
  try {
    const client = new VectisClient(server.connection);
    const signal = new AbortController().signal;
    const status = JSON.parse(await answerInspection('{"name":"status"}', client, signal));
    expect(status).toMatchObject({ ok: true, result: { protocolVersion: 1, environments: [] } });
    expect(
      JSON.parse(await answerInspection('{"name":"github.accounts"}', client, signal)),
    ).toMatchObject({ ok: false });
    expect(JSON.parse(await answerInspection('{"name":"shutdown"}', client, signal))).toMatchObject(
      { ok: false, code: "inspection_failed" },
    );
    expect((await client.status()).machine.id).toBeDefined();
    await expect(
      answerInspection('{"name":"status"}', client, AbortSignal.abort()),
    ).rejects.toThrow();
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
