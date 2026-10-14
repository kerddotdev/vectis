import { expect, test } from "vitest";
import type {
  Activity,
  Environment,
  Snapshot,
} from "../../../../../packages/protocol/src/index.js";
import { onboardingSteps } from "./onboarding.js";

const environment = (state: Environment["state"]): Environment => ({
  id: `env-${state}`,
  name: "Ubuntu",
  os: "linux",
  basePath: "/tmp/base.img",
  cpu: 4,
  memoryMiB: 8192,
  state,
});

const activity = (
  id: string,
  subject: Activity["subject"],
  status: Activity["status"],
): Activity => ({
  id,
  kind: "vectis",
  subject,
  status,
  message: "",
  createdAt: "2026-10-14T10:00:00.000Z",
  updatedAt: "2026-10-14T10:00:00.000Z",
  rootOperationId: `op-${id}`,
});

const binding = {
  id: "binding-1",
  repositoryId: 1,
  repositoryName: "kerd/vectis",
  environmentId: "env-ready",
};

function snapshot(overrides: Partial<Snapshot>): Snapshot {
  return {
    protocolVersion: 1,
    machine: { id: "machine", name: "Mac", paused: false },
    environments: [],
    instances: [],
    operations: [],
    ...overrides,
  };
}

const states = (value: Snapshot) => onboardingSteps(value)?.map((step) => step.state);

test("a fresh machine starts with preparing an environment", () => {
  expect(states(snapshot({}))).toEqual(["current", "upcoming", "upcoming"]);
});

test("an environment that still needs setup does not count, but its preparation is shown", () => {
  const preparing = activity(
    "prep",
    { type: "preparation", setupId: "setup", os: "linux" },
    "running",
  );
  const steps = onboardingSteps(
    snapshot({ environments: [environment("action_required")], activities: [preparing] }),
  );
  expect(steps?.[0]).toEqual({ id: "environment", state: "current", activity: preparing });
});

test("a connected repository moves the guide to the first job", () => {
  expect(
    states(snapshot({ environments: [environment("ready")], repositories: [binding] })),
  ).toEqual(["done", "done", "current"]);
});

test("a runner that never received a job does not finish the guide", () => {
  const waiting = activity("runner", { type: "runner" }, "running");
  const failed = activity("old", { type: "runner" }, "failed");
  const steps = onboardingSteps(
    snapshot({
      environments: [environment("ready")],
      repositories: [binding],
      activities: [waiting, failed],
    }),
  );
  expect(steps?.[2]).toEqual({ id: "job", state: "current", activity: waiting });
});

test("the guide disappears once a job was observed or a runner succeeded", () => {
  const ready = { environments: [environment("ready")], repositories: [binding] };
  const observed = activity("a", { type: "runner", actualJob: { jobId: 7 } }, "failed");
  const succeeded = activity("b", { type: "runner" }, "succeeded");
  expect(onboardingSteps(snapshot({ ...ready, activities: [observed] }))).toBeUndefined();
  expect(onboardingSteps(snapshot({ ...ready, activities: [succeeded] }))).toBeUndefined();
});

test("a lost environment becomes the current step again even after later steps are done", () => {
  const ran = activity("a", { type: "runner", actualJob: { jobId: 7 } }, "succeeded");
  expect(states(snapshot({ repositories: [binding], activities: [ran] }))).toEqual([
    "current",
    "done",
    "done",
  ]);
});
