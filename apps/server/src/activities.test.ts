import { expect, test } from "vitest";
import type { ActivityBase, Operation } from "../../../packages/protocol/src/index.js";
import { activityFor, deriveActivity } from "./activities.js";

function member(id: string, status: Operation["status"], updatedAt: string): Operation {
  return { id, key: id, command: "test", status, createdAt: "2026-01-01", updatedAt, message: id };
}
const preparation: ActivityBase = {
  id: "setup",
  kind: "vectis",
  subject: { type: "preparation", setupId: "setup", os: "macos" },
  rootOperationId: "install",
  createdAt: "2026-01-01",
};

test("a preparation follows the latest attempt, including recovery from a failed verification", () => {
  const members = [
    member("install", "action_required", "2026-01-05"),
    member("verify-failed", "failed", "2026-01-02"),
  ];
  expect(deriveActivity(preparation, members)).toMatchObject({
    status: "failed",
    message: "verify-failed",
    completedAt: "2026-01-02",
  });
  members.push(member("verify-ok", "succeeded", "2026-01-03"));
  expect(deriveActivity(preparation, members)).toMatchObject({
    status: "succeeded",
    message: "verify-ok",
    updatedAt: "2026-01-05",
    completedAt: "2026-01-03",
  });
  members.push(member("open-console", "action_required", "2026-01-04"));
  const waiting = deriveActivity(preparation, members);
  expect(waiting?.status).toBe("action_required");
  expect(waiting).not.toHaveProperty("completedAt");
  members.push(member("discard", "cancelled", "2026-01-06"));
  expect(deriveActivity(preparation, members)?.status).toBe("cancelled");
});

test("runner cleanup children cannot replace the root outcome", () => {
  const base: ActivityBase = {
    ...preparation,
    id: "runner",
    kind: "github",
    rootOperationId: "runner",
    subject: { type: "runner" },
  };
  const members = [
    member("runner", "succeeded", "2026-01-02"),
    member("stop", "failed", "2026-01-03"),
  ];
  expect(deriveActivity(base, members)).toMatchObject({
    status: "succeeded",
    message: "runner",
    updatedAt: "2026-01-03",
    completedAt: "2026-01-02",
  });
  expect(deriveActivity(base, [member("stop", "succeeded", "2026-01-03")])).toBeUndefined();
});

test("command activities follow their root and empty bases produce no activity", () => {
  const base: ActivityBase = { ...preparation, subject: { type: "command", command: "job.scan" } };
  expect(
    deriveActivity(base, [
      member("install", "running", "2026-01-02"),
      member("child", "succeeded", "2026-01-03"),
    ])?.status,
  ).toBe("running");
  expect(deriveActivity(base, [])).toBeUndefined();
});

test("only a successful preparation discard cancels the parent intent", () => {
  const discard = {
    ...member("discard", "succeeded", "2026-01-02"),
    command: "environment.discard-macos",
  };
  expect(deriveActivity(preparation, [discard])).toMatchObject({
    status: "cancelled",
    completedAt: discard.updatedAt,
    message: "The unregistered macOS setup was explicitly discarded.",
  });
  expect(deriveActivity(preparation, [{ ...discard, status: "failed" }])).toMatchObject({
    status: "failed",
    message: "discard",
  });
  expect(
    deriveActivity(
      {
        ...preparation,
        rootOperationId: discard.id,
        subject: { type: "command", command: discard.command },
      },
      [discard],
    )?.status,
  ).toBe("succeeded");
});

test("new intents and continuations retain setup identity without turning maintenance into activities", () => {
  expect(
    activityFor("toggle", { type: "repository.automatic", bindingId: "binding", enabled: true }),
  ).toBeUndefined();
  expect(
    activityFor("scan", { type: "job.scan", bindingId: "binding", automatic: true }),
  ).toBeUndefined();
  expect(activityFor("scan", { type: "job.scan", bindingId: "binding" })).toMatchObject({
    activityId: "scan",
    create: { kind: "vectis", subject: { type: "command", command: "job.scan" } },
  });
  expect(
    activityFor("run", { type: "runner.run", bindingId: "binding", jobId: 123 }),
  ).toMatchObject({
    activityId: "run",
    create: {
      kind: "github",
      bindingId: "binding",
      subject: { type: "runner", requestedJob: { jobId: 123 } },
    },
  });
  for (const type of ["environment.prepare-linux", "environment.install-macos"] as const) {
    expect(
      activityFor("setup", {
        type,
        id: "image",
        name: "Image",
        cpu: 2,
        memoryMiB: 2048,
        diskGiB: 40,
        imageDirectory: "/unused",
        storagePath: "/unused",
      }),
    ).toMatchObject({
      activityId: "setup",
      create: {
        environmentId: "image",
        subject: {
          type: "preparation",
          setupId: "setup",
          os: type.endsWith("linux") ? "linux" : "macos",
        },
      },
    });
  }
  for (const [type, os] of [
    ["environment.resume", "linux"],
    ["environment.verify-macos-guest", "macos"],
    ["environment.resume-windows", "windows"],
  ] as const) {
    expect(activityFor("attempt", { type, id: "setup" })).toMatchObject({
      activityId: "setup",
      create: { subject: { type: "preparation", setupId: "setup", os } },
    });
  }
  expect(activityFor("recover", { type: "runner.reconcile", id: "run" })).toMatchObject({
    activityId: "run",
    create: { kind: "github", rootOperationId: "run", subject: { type: "runner" } },
  });
  expect(
    activityFor("start", { type: "environment.start", id: "image" })?.create?.environmentId,
  ).toBe("image");
});
