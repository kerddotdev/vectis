import { expect, test } from "vitest";
import { Schema } from "effect";
import { decodeCommand, Environment, Instance, Request } from "./index.js";
import { ControllerRequest } from "./controller.js";

test.each([0, 1, 4])(
  "warm pool size %s crosses local, MCP and controller boundaries",
  (warmPool) => {
    const command = { type: "environment.configure", id: "linux", warmPool };
    expect(decodeCommand(command)).toEqual(command);
    expect(Schema.decodeUnknownSync(Request)({ key: "pool", command }).command).toEqual(command);
    expect(
      Schema.decodeUnknownSync(ControllerRequest)({
        type: "operation.submit",
        machineId: "host",
        key: "pool",
        command,
      }),
    ).toMatchObject({ command });
    expect(JSON.stringify(Schema.toJsonSchemaDocument(Request))).toContain('"warmPool"');
  },
);

test.each([-1, 5, 0.5, "1", NaN, Infinity])("invalid warm pool size %s is rejected", (warmPool) => {
  expect(() => decodeCommand({ type: "environment.configure", id: "linux", warmPool })).toThrow();
});

test("legacy snapshots remain valid while pool roles preserve lifecycle status", () => {
  const environment = {
    id: "linux",
    name: "Linux",
    os: "linux",
    basePath: "/unused/base",
    cpu: 1,
    memoryMiB: 512,
    state: "ready",
  };
  expect(Schema.decodeUnknownSync(Environment)(environment)).not.toHaveProperty("warmPool");
  expect(Schema.decodeUnknownSync(Environment)({ ...environment, warmPool: 4 }).warmPool).toBe(4);
  expect(() => Schema.decodeUnknownSync(Environment)({ ...environment, warmPool: 5 })).toThrow();
  const instance = { id: "test", environmentId: "linux", status: "running", pid: 0, createdAt: "" };
  expect(Schema.decodeUnknownSync(Instance)(instance)).not.toHaveProperty("role");
  expect(Schema.decodeUnknownSync(Instance)({ ...instance, role: "warm" })).toMatchObject({
    status: "running",
    role: "warm",
  });
  expect(
    Schema.decodeUnknownSync(Instance)({ ...instance, status: "starting", role: "warming" }),
  ).toMatchObject({ status: "starting", role: "warming" });
});
