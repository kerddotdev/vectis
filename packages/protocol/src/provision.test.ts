import { Schema } from "effect";
import { expect, test } from "vitest";
import { Command, Snapshot, capabilities, commandActivity, decodeCommand } from "./index.js";

const command = {
  type: "environment.provision",
  id: "derived",
  from: "parent",
  imageDirectory: "/isolated/new-image",
};

test("provisioning decodes optional inputs, bounds UTF-8 script bytes and derives the MCP schema", () => {
  expect(decodeCommand(command)).toEqual(command);
  expect(
    decodeCommand({ ...command, runner: false, setupScript: "x".repeat(65536) }),
  ).toMatchObject({ runner: false });
  expect(() => decodeCommand({ ...command, setupScript: "x".repeat(65537) })).toThrow();
  expect(() => decodeCommand({ ...command, setupScript: "é".repeat(32769) })).toThrow();
  expect(() => decodeCommand({ ...command, id: "../parent" })).toThrow();
  expect(commandActivity["environment.provision"]).toBe("intent");
  expect(capabilities).toContainEqual(
    expect.objectContaining({ name: command.type, kind: "command" }),
  );
  expect(JSON.stringify(Schema.toJsonSchemaDocument(Command))).toContain('"environment.provision"');
});

test("snapshots accept legacy environments and retain optional image manifests", () => {
  const environment = {
    id: "parent",
    name: "Parent",
    os: "linux",
    basePath: "/isolated/base.img",
    cpu: 1,
    memoryMiB: 512,
    state: "ready",
  };
  const image = {
    parentId: "parent",
    revision: "revision",
    runnerVersion: "2.337.0",
    provisionedAt: "2026-10-16T00:00:00.000Z",
  };
  const snapshot = Schema.decodeUnknownSync(Snapshot)({
    protocolVersion: 1,
    machine: { id: "host", name: "Host", paused: false },
    environments: [environment, { ...environment, id: "derived", image }],
    instances: [],
    operations: [],
  });
  expect(snapshot.environments[0]?.image).toBeUndefined();
  expect(snapshot.environments[1]?.image).toEqual(image);
});
