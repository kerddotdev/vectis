import { expect, it } from "vitest";
import { env, SELF, seedMachine, readyLinux } from "../src/test-support.js";
import { machinePresence } from "../src/notify.js";
import { purgeMachine } from "../src/machines.js";

async function connect(bearer: string) {
  const encoded = btoa(bearer).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const response = await SELF.fetch("https://cloud.test/machine/socket", {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `vectis.v1, auth.${encoded}` },
  });
  expect(response.status).toBe(101);
  expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("vectis.v1");
  const socket = response.webSocket!;
  socket.accept();
  return socket;
}
function message(socket: WebSocket) {
  return new Promise<string>((resolve) =>
    socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true }),
  );
}
function closed(socket: WebSocket) {
  return new Promise<number>((resolve) =>
    socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
  );
}

it("echoes the protocol, automatically answers pings and reports presence", async () => {
  const machine = await seedMachine();
  expect(await machinePresence(env, machine.id)).toMatchObject({ online: false, lastSeenAt: null });
  const socket = await connect(machine.bearer);
  const pong = message(socket);
  socket.send("ping");
  expect(await pong).toBe("pong");
  expect(await machinePresence(env, machine.id)).toMatchObject({ online: true });
  await env.HUB.getByName(machine.id).disconnect(4000);
  expect((await machinePresence(env, machine.id)).online).toBe(false);
  socket.close();
});

it("replaces connections and closes the current socket when purged", async () => {
  const machine = await seedMachine();
  const first = await connect(machine.bearer);
  const replaced = closed(first);
  const second = await connect(machine.bearer);
  expect(await replaced).toBe(4002);
  const removed = closed(second);
  await purgeMachine(env, machine.id);
  expect(await removed).toBe(4001);
  expect(
    await env.DB.prepare("SELECT id FROM machines WHERE id = ?").bind(machine.id).first(),
  ).toBeNull();
});

it("acknowledges valid status, rejects duplicates and writes only changed inventory", async () => {
  const machine = await seedMachine();
  const socket = await connect(machine.bearer);
  await env.DB.exec(
    "CREATE TABLE statusWrites (id INTEGER); CREATE TRIGGER count_status_writes AFTER UPDATE ON machines BEGIN INSERT INTO statusWrites VALUES (1); END;",
  );
  const pong = message(socket);
  socket.send("ping");
  expect(await pong).toBe("pong");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM statusWrites").first("n")).toBe(0);
  const status = {
    t: "status",
    seq: 1,
    paused: false,
    runnerIdle: true,
    runnerSlots: 1,
    environments: [readyLinux()],
  };
  let received = message(socket);
  socket.send(JSON.stringify(status));
  expect(JSON.parse(await received)).toEqual({ t: "status.ack", seq: 1 });
  received = message(socket);
  socket.send(JSON.stringify({ ...status, seq: 2 }));
  expect(JSON.parse(await received)).toEqual({ t: "status.ack", seq: 2 });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM statusWrites").first("n")).toBe(1);
  received = message(socket);
  socket.send(JSON.stringify({ ...status, seq: 3, environments: [readyLinux(), readyLinux()] }));
  expect(JSON.parse(await received)).toEqual({
    t: "status.rejected",
    seq: 3,
    code: "invalid_environment_inventory",
  });
  received = message(socket);
  socket.send(JSON.stringify({ ...status, seq: 4, runnerSlots: -1 }));
  expect(JSON.parse(await received)).toEqual({
    t: "status.rejected",
    seq: 4,
    code: "invalid_runner_capacity",
  });
  received = message(socket);
  socket.send("{");
  expect(JSON.parse(await received)).toMatchObject({
    t: "status.rejected",
    code: "invalid_status",
  });
  expect(await machinePresence(env, machine.id)).toMatchObject({
    runnerIdle: true,
    runnerSlots: 1,
  });
  socket.close();
});
