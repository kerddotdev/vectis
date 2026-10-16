import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { startService } from "../../../apps/server/src/http.js";
import { VectisClient } from "./index.js";
import { VectisError } from "../../protocol/src/index.js";
import { answerInspection } from "./inspection.js";
import { activityFor } from "../../../apps/server/src/activities.js";

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
    const readiness = await client.repositoryReadiness({ repositoryName: "owner/repo" });
    expect(
      JSON.parse(
        await answerInspection(
          JSON.stringify({ name: "repository.readiness", input: { repositoryName: "owner/repo" } }),
          client,
          signal,
        ),
      ),
    ).toEqual({ ok: true, result: readiness });
    expect((await client.status()).machine.id).toBeDefined();
    await expect(
      answerInspection('{"name":"status"}', client, AbortSignal.abort()),
    ).rejects.toThrow();
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("inspection failures redact error messages and recovery advice sent to the cloud", async () => {
  const canary = "InspectionFailureCanary123456789";
  const client = new VectisClient({ url: "http://127.0.0.1:1", token: "unused" });
  const status = vi
    .spyOn(client, "status")
    .mockRejectedValue(
      new VectisError(
        "inspection_failed",
        `token=${canary}`,
        `password=${canary} inspect /tmp/runner`,
      ),
    );
  try {
    const response = await answerInspection(
      '{"name":"status"}',
      client,
      new AbortController().signal,
    );
    expect(response).not.toContain(canary);
    expect(JSON.parse(response)).toEqual({
      ok: false,
      code: "inspection_failed",
      message: "token=[redacted]",
      nextStep: "password=[redacted] inspect /tmp/runner",
    });
  } finally {
    status.mockRestore();
  }
});

test("job log inspections use the authenticated HTTP contract and fit the encoded response cap", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-job-inspection-"));
  const server = await startService({ home });
  try {
    const local = new VectisClient(server.connection);
    const log = {
      text: "\u0000".repeat(32768),
      next: 32768,
      status: "in_progress" as const,
      complete: false,
      truncated: true,
    };
    const read = vi.spyOn(server.service, "jobLogs").mockResolvedValue(log);
    const signal = new AbortController().signal;
    const encoded = await answerInspection(
      JSON.stringify({ name: "job.logs", bindingId: "binding", jobId: 4, after: 0 }),
      local,
      signal,
    );
    expect(Buffer.byteLength(encoded)).toBeLessThan(262144);
    expect(JSON.parse(encoded)).toEqual({ ok: true, result: log });
    expect(read).toHaveBeenCalledWith(
      { bindingId: "binding", jobId: 4, after: 0 },
      expect.any(AbortSignal),
    );
    read.mockResolvedValue({ ...log, text: "\u00e9".repeat(140000) });
    expect(
      JSON.parse(
        await answerInspection(
          '{"name":"job.logs","bindingId":"binding","jobId":4}',
          local,
          signal,
        ),
      ),
    ).toMatchObject({ ok: false, code: "query_result_too_large" });
    read.mockClear();
    const response = await fetch(
      new URL("/v1/jobs/logs?bindingId=binding&jobId=4&after=-1", server.connection.url),
      { headers: { Authorization: `Bearer ${server.connection.token}` } },
    );
    expect(response.ok).toBe(false);
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("operation and activity inspections bypass a status snapshot larger than the remote cap", async () => {
  const home = await mkdtemp(join(tmpdir(), "vectis-targeted-inspection-"));
  const server = await startService({ home });
  try {
    const local = new VectisClient(server.connection);
    const command = { type: "job.scan", bindingId: "binding" } as const;
    const operation = server.store.accept(
      "target",
      "target",
      command.type,
      activityFor("target", command),
      "target",
    ).operation;
    for (let index = 0; index < 110; index++) {
      const other = server.store.accept(`other-${index}`, "other", "machine.pause").operation;
      server.store.update(other, { status: "succeeded", result: { text: "x".repeat(4096) } });
    }
    const signal = new AbortController().signal;
    expect(JSON.parse(await answerInspection('{"name":"status"}', local, signal))).toMatchObject({
      ok: false,
      code: "query_result_too_large",
    });
    const status = vi.spyOn(local, "status").mockRejectedValue(new Error("Unexpected full status"));
    for (const query of [
      { name: "operation", id: operation.id },
      { name: "operation.key", key: "target" },
    ]) {
      const encoded = await answerInspection(JSON.stringify(query), local, signal);
      expect(Buffer.byteLength(encoded)).toBeLessThan(262144);
      expect(JSON.parse(encoded)).toEqual({ ok: true, result: operation });
    }
    expect(
      JSON.parse(await answerInspection('{"name":"activity","id":"target"}', local, signal)),
    ).toMatchObject({
      ok: true,
      result: { activity: { id: "target" }, operations: [operation] },
    });
    expect(
      JSON.parse(await answerInspection('{"name":"activities"}', local, signal)),
    ).toMatchObject({
      ok: true,
      result: [{ id: "target" }],
    });
    expect(status).not.toHaveBeenCalled();
    status.mockRestore();
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
