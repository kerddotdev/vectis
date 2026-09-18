import { expect, test } from "vitest";
import { desktopTarget } from "./target.js";

test("remote desktop requests cannot open local file pickers or manage local services", () => {
  for (const action of [
    "service.install",
    "service.stop",
    "cloud.pair",
    "cloud.finish",
    "chooseFile",
    "chooseDirectory",
    "chooseRestoreImage",
  ]) {
    expect(() => desktopTarget(action, "remote-machine")).toThrow(
      "This action is available only when This Mac is selected.",
    );
    expect(desktopTarget(action, undefined)).toBeUndefined();
  }
  expect(desktopTarget("command", "remote-machine")).toBe("remote-machine");
  expect(desktopTarget("status", "remote-machine")).toBe("remote-machine");
  expect(() => desktopTarget("command", "")).toThrow();
  expect(() => desktopTarget("command", null)).toThrow();
});
