import { beforeEach, expect, it } from "vitest";
import {
  env,
  seedMachine,
  seedAccount,
  seedBinding,
  readyLinux,
  SELF,
} from "../src/test-support.js";
import {
  bindingRecord,
  type BindingRow,
  type DemandRow,
  type JobRow,
  type OperationRow,
} from "../src/db.js";
import { evaluateDemand, sweepDemand } from "../src/runners/demand.js";
import { planDemand } from "../src/runners/plan-demand.js";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM machines"),
    env.DB.prepare("DELETE FROM githubAccounts"),
    env.DB.prepare("DELETE FROM githubJobs"),
  ]);
});

async function fixture() {
  const machine = await seedMachine({ paused: false, environments: [readyLinux()] });
  const account = await seedAccount(machine.owner);
  const binding = await seedBinding({
    owner: machine.owner,
    machineId: machine.id,
    accountId: account.id,
    automatic: true,
  });
  await env.DB.prepare(`INSERT INTO githubJobs (installationId, repositoryId, jobId, runId, name, status, labelsJson, updatedAt)
    VALUES (10, 1000, 1, 2, 'Build', 'queued', '["vectis-linux"]', 1)`).run();
  const row = await env.DB.prepare("SELECT * FROM repositoryBindings WHERE id = ?")
    .bind(binding.id)
    .first<BindingRow>();
  const job = await env.DB.prepare("SELECT * FROM githubJobs WHERE jobId = 1").first<JobRow>();
  return { machine, account, binding: bindingRecord(row!), job: job! };
}

it("atomically reserves a queued job across two competing machines", async () => {
  const { machine, account } = await fixture();
  const second = await seedMachine({
    owner: machine.owner,
    paused: false,
    environments: [readyLinux()],
  });
  await seedBinding({
    owner: machine.owner,
    machineId: second.id,
    accountId: account.id,
    automatic: true,
  });
  const capacity = { runnerSlots: 1, statusAt: Date.now() };
  await Promise.all([
    evaluateDemand(env, machine.id, capacity),
    evaluateDemand(env, second.id, capacity),
  ]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM operations").first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM runnerDemands").first("n")).toBe(1);
  await evaluateDemand(env, machine.id, capacity);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM operations").first("n")).toBe(1);
});

it("coalesces concurrent hub evaluations without double claiming", async () => {
  const { machine } = await fixture();
  const response = await SELF.fetch("https://cloud.test/machine/socket", {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `vectis.v1, auth.${btoa(machine.bearer).replace(/=+$/, "")}`,
    },
  });
  const socket = response.webSocket!;
  socket.accept();
  const ack = new Promise<void>((resolve) =>
    socket.addEventListener("message", () => resolve(), { once: true }),
  );
  socket.send(
    JSON.stringify({
      t: "status",
      seq: 1,
      paused: false,
      runnerIdle: true,
      runnerSlots: 2,
      environments: [readyLinux()],
    }),
  );
  await ack;
  await Promise.all([
    env.HUB.getByName(machine.id).demand(),
    env.HUB.getByName(machine.id).demand(),
  ]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM operations").first("n")).toBe(1);
  socket.close();
});

it("has no legacy idle fallback and respects environment capacity and reservations", async () => {
  const { machine, binding, job } = await fixture();
  const queues = [{ binding, environment: readyLinux(), jobs: [job, { ...job, jobId: 2 }] }];
  const base = { owner: machine.owner, queues, demands: [], operations: [], now: 1000000 };
  expect(planDemand({ ...base, capacity: { statusAt: 100 } })).toHaveLength(0);
  expect(
    planDemand({
      ...base,
      capacity: {
        statusAt: 100,
        runnerSlots: 2,
        environmentSlots: [{ environmentId: "linux", available: 1 }],
      },
    }),
  ).toHaveLength(1);
  const operation: OperationRow = {
    id: "op",
    owner: machine.owner,
    machineId: machine.id,
    key: "op",
    commandJson: JSON.stringify({ type: "runner.run", bindingId: binding.id, automatic: true }),
    phase: "claimed",
    createdAt: 1,
    updatedAt: 99,
    resultJson: null,
    cancelRequested: 0,
  };
  expect(
    planDemand({ ...base, operations: [operation], capacity: { statusAt: 100, runnerSlots: 1 } }),
  ).toHaveLength(0);
  expect(
    planDemand({
      ...base,
      operations: [
        {
          ...operation,
          commandJson: JSON.stringify({
            type: "runner.run",
            bindingId: "disabled-binding",
            automatic: true,
          }),
          reservedEnvironmentId: "linux",
        },
      ],
      capacity: {
        statusAt: 100,
        runnerSlots: 2,
        environmentSlots: [{ environmentId: "linux", available: 1 }],
      },
    }),
  ).toHaveLength(0);
  expect(
    planDemand({
      ...base,
      operations: [{ ...operation, phase: "running" }],
      capacity: { statusAt: 100, runnerSlots: 1 },
    }),
  ).toHaveLength(1);
});

it("preserves retry delays, attempt limits, failure limits, cache errors and cancellation rules", async () => {
  const { machine, binding, job } = await fixture();
  const now = 1000000;
  const demand: DemandRow = {
    installationId: 10,
    repositoryId: 1000,
    jobId: 1,
    owner: machine.owner,
    bindingId: binding.id,
    operationId: "op",
    attempt: 1,
    failures: 0,
    updatedAt: now - 600001,
  };
  const operation: OperationRow = {
    id: "op",
    owner: machine.owner,
    machineId: machine.id,
    key: "op",
    commandJson: "{}",
    phase: "failed",
    createdAt: 0,
    updatedAt: now - 60000,
    resultJson: null,
    cancelRequested: 0,
  };
  const plan = (previous: OperationRow | undefined, changes: Partial<DemandRow> = {}) =>
    planDemand({
      owner: machine.owner,
      capacity: { statusAt: now, runnerSlots: 1 },
      queues: [{ binding, environment: readyLinux(), jobs: [job] }],
      demands: [
        { demand: { ...demand, ...changes }, ...(previous ? { operation: previous } : {}) },
      ],
      operations: [],
      now,
    });
  expect(plan(operation)[0]).toMatchObject({ attempt: 2, failures: 1 });
  expect(plan({ ...operation, updatedAt: now - 59999 })).toHaveLength(0);
  expect(plan({ ...operation, phase: "action_required", updatedAt: now - 599999 })).toHaveLength(0);
  expect(plan({ ...operation, phase: "action_required", updatedAt: now - 600000 })).toHaveLength(1);
  expect(plan(operation, { attempt: 10 })).toHaveLength(0);
  expect(plan(operation, { failures: 2 })).toHaveLength(0);
  expect(
    plan({ ...operation, resultJson: '{"code":"cache_volume_requires_guest_sudo"}' }),
  ).toHaveLength(0);
  expect(plan(undefined, { updatedAt: now - 599999 })).toHaveLength(0);
  expect(plan(undefined)).toHaveLength(1);
  expect(plan({ ...operation, phase: "cancelled", createdAt: 2 })).toHaveLength(0);
  expect(
    plan({
      ...operation,
      phase: "cancelled",
      createdAt: 2,
      resultJson: '{"code":"machine_offline"}',
    })[0],
  ).toMatchObject({ failures: 1 });
  expect(
    plan({
      ...operation,
      phase: "cancelled",
      createdAt: 2,
      cancelRequested: 1,
      resultJson: '{"code":"machine_offline"}',
    }),
  ).toHaveLength(0);
});

it("sweeps an empty queued-job index without creating work", async () => {
  await sweepDemand(env, Date.now());
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM operations").first("n")).toBe(0);
});
