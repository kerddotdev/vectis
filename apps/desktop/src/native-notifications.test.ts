import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import type { Activity, Snapshot } from "../../../packages/protocol/src/index.js";
import { NativeNotifications } from "./native-notifications.js";

const snapshot: Snapshot = {
  protocolVersion: 1,
  machine: { id: "local", name: "Synthetic Mac", paused: false },
  environments: [],
  instances: [],
  operations: [],
};
function activity(status: Activity["status"]): Activity {
  return {
    id: "activity with spaces",
    kind: "vectis",
    subject: { type: "command", command: "repository.connect" },
    rootOperationId: "operation",
    createdAt: "2026-10-14T10:00:00Z",
    updatedAt: "2026-10-14T10:00:00Z",
    status,
    message: "GitHub access is required.",
  };
}

class FakeNotification extends EventEmitter {
  readonly show = vi.fn();
  readonly close = vi.fn(() => this.emit("close"));
  constructor(readonly content: { title: string; body: string }) {
    super();
  }
}

function nativeNotifications() {
  const created: FakeNotification[] = [];
  const openActivity = vi.fn();
  const notifications = new NativeNotifications((content) => {
    const notification = new FakeNotification(content);
    created.push(notification);
    return notification;
  }, openActivity);
  return { notifications, created, openActivity };
}

test.each([
  ["action_required", "Vectis needs you"],
  ["failed", "Vectis work failed"],
] as const)(
  "%s notifications show the shared activity content and open the activity on click",
  (status, title) => {
    const fake = nativeNotifications();
    const work = activity(status);
    fake.notifications.show(work, snapshot);
    const notification = fake.created[0];
    expect(notification?.content).toEqual({
      title,
      body: "Connect repository\nGitHub access is required.",
    });
    expect(notification?.show).toHaveBeenCalledOnce();
    notification?.emit("click");
    expect(fake.openActivity).toHaveBeenCalledExactlyOnceWith(work.id);
    expect(notification?.close).toHaveBeenCalledOnce();
    expect(notification?.eventNames()).toEqual([]);
    fake.notifications.close();
    expect(notification?.close).toHaveBeenCalledOnce();
  },
);

test.each(["close", "failed"])(
  "a native %s event releases the retained notification and its listeners",
  (event) => {
    const fake = nativeNotifications();
    fake.notifications.show(activity("failed"), snapshot);
    const notification = fake.created[0];
    notification?.emit(event);
    expect(notification?.eventNames()).toEqual([]);
    fake.notifications.close();
    expect(notification?.close).not.toHaveBeenCalled();
    expect(fake.openActivity).not.toHaveBeenCalled();
  },
);

test("retained native notifications are bounded and quit closes all remaining notifications", () => {
  const fake = nativeNotifications();
  for (let index = 0; index < 51; index++) fake.notifications.show(activity("failed"), snapshot);
  expect(fake.created[0]?.close).toHaveBeenCalledOnce();
  expect(fake.created[0]?.eventNames()).toEqual([]);
  expect(fake.created[1]?.close).not.toHaveBeenCalled();
  fake.notifications.close();
  for (const notification of fake.created) {
    expect(notification.close).toHaveBeenCalledOnce();
    expect(notification.eventNames()).toEqual([]);
  }
});

test("a synchronous native display failure releases the notification", () => {
  const notification = new FakeNotification({ title: "Failure", body: "Synthetic" });
  notification.show.mockImplementation(() => {
    throw new Error("Unavailable");
  });
  const notifications = new NativeNotifications(() => notification, vi.fn());
  expect(() => notifications.show(activity("failed"), snapshot)).toThrow("Unavailable");
  expect(notification.close).toHaveBeenCalledOnce();
  expect(notification.eventNames()).toEqual([]);
  notifications.close();
  expect(notification.close).toHaveBeenCalledOnce();
});
