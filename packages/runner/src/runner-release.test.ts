import { expect, test } from "vitest";
import { runnerStartScript } from "./runner-release.js";

test("rejects malformed JIT configuration before generating guest shell commands", () => {
  for (const config of ["", "token'; command", "$(command)", "line\nbreak", "a".repeat(60001)])
    for (const os of ["linux", "macos", "windows"] as const)
      expect(() => runnerStartScript(os, config)).toThrow("configuration is invalid");
});
