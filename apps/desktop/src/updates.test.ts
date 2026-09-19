import { afterEach, expect, test, vi } from "vitest";
import { UpdateController, type UpdaterEvent } from "./updates.js";

function fakeUpdater() {
  let listener: ((event: UpdaterEvent) => void) | undefined;
  return {
    check: vi.fn(async () => {}),
    quitAndInstall: vi.fn(),
    subscribe: (next: (event: UpdaterEvent) => void) => {
      listener = next;
    },
    emit: (event: UpdaterEvent) => listener?.(event),
  };
}

afterEach(() => vi.useRealTimers());

test("an update waits for running work, then stops the idle service and installs once", async () => {
  vi.useFakeTimers();
  const updater = fakeUpdater();
  const states = ["busy", "busy", "stopped"] as const;
  const service = {
    stopIfIdle: vi.fn(async () => states[service.stopIfIdle.mock.calls.length - 1] ?? "stopped"),
    rememberRestart: vi.fn(async () => {}),
  };
  const controller = new UpdateController(updater, service, {
    checkIntervalMs: 3600000,
    retryIdleMs: 30000,
  });
  updater.emit({ type: "available", version: "0.2.0" });
  updater.emit({ type: "progress", percent: 42 });
  expect(controller.current()).toEqual({ status: "downloading", version: "0.2.0", percent: 42 });
  updater.emit({ type: "downloaded", version: "0.2.0" });
  expect(await controller.install()).toEqual({ status: "waiting", version: "0.2.0" });
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30000);
  expect(controller.current()).toEqual({ status: "waiting", version: "0.2.0" });
  await vi.advanceTimersByTimeAsync(30000);
  expect(controller.current()).toEqual({ status: "installing", version: "0.2.0" });
  expect(service.rememberRestart).toHaveBeenCalledOnce();
  expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(3600000);
  expect(updater.check).not.toHaveBeenCalled();
});

test("a service that was not running is not started after the update", async () => {
  const updater = fakeUpdater();
  const service = {
    stopIfIdle: vi.fn(async () => "not-running" as const),
    rememberRestart: vi.fn(async () => {}),
  };
  const controller = new UpdateController(updater, service, {
    checkIntervalMs: 3600000,
    retryIdleMs: 30000,
  });
  updater.emit({ type: "downloaded", version: "0.2.0" });
  await controller.install();
  expect(service.rememberRestart).not.toHaveBeenCalled();
  expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  controller.close();
});

test("installing without a downloaded update does nothing", async () => {
  const updater = fakeUpdater();
  const service = { stopIfIdle: vi.fn(), rememberRestart: vi.fn() };
  const controller = new UpdateController(updater, service, {
    checkIntervalMs: 3600000,
    retryIdleMs: 30000,
  });
  expect(await controller.install()).toEqual({ status: "idle" });
  expect(service.stopIfIdle).not.toHaveBeenCalled();
});
