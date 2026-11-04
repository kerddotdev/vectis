import { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { SleepAssertion } from "./sleep-assertion.js";

describe("SleepAssertion", () => {
  it("holds one child until owned work becomes idle", () => {
    const child = new ChildProcess();
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    const spawnChild = vi.fn().mockReturnValue(child);
    const assertion = new SleepAssertion(spawnChild, "darwin");

    assertion.update(0);
    assertion.update(1);
    assertion.update(2);
    assertion.update(1);
    expect(spawnChild).toHaveBeenCalledOnce();
    expect(spawnChild).toHaveBeenCalledWith(
      "/usr/bin/caffeinate",
      ["-i", "-w", String(process.pid)],
      { stdio: "ignore" },
    );
    expect(kill).not.toHaveBeenCalled();
    assertion.update(0);
    expect(kill).toHaveBeenCalledOnce();
    assertion.close();
    expect(kill).toHaveBeenCalledOnce();
  });

  it("releases the child on shutdown", () => {
    const child = new ChildProcess();
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    const assertion = new SleepAssertion(vi.fn().mockReturnValue(child), "darwin");
    assertion.update(1);
    assertion.close();
    expect(kill).toHaveBeenCalledOnce();
  });

  it("logs a spawn error once and retries only after becoming idle", () => {
    const child = new ChildProcess();
    const spawnChild = vi.fn().mockReturnValue(child);
    const log = vi.fn();
    const assertion = new SleepAssertion(spawnChild, "darwin", log);
    assertion.update(1);
    expect(() => child.emit("error", new Error("missing"))).not.toThrow();
    child.emit("exit", 1, null);
    assertion.update(2);
    expect(log).toHaveBeenCalledOnce();
    expect(spawnChild).toHaveBeenCalledOnce();
    assertion.update(0);
    assertion.update(1);
    expect(spawnChild).toHaveBeenCalledTimes(2);
  });
});
