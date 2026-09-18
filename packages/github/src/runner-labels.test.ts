import { expect, test } from "vitest";
import { matchesRunnerLabels } from "./runner-labels.js";

test("automatic demand requires the environment label and every requested capability", () => {
  expect(matchesRunnerLabels(["SELF-HOSTED", "MACOS", "ARM64", "VECTIS-MAC"], "macos", "mac")).toBe(
    true,
  );
  expect(matchesRunnerLabels(["self-hosted"], "macos", "mac")).toBe(false);
  expect(matchesRunnerLabels(["vectis-mac", "X64"], "macos", "mac")).toBe(false);
  expect(matchesRunnerLabels(["vectis-other"], "macos", "mac")).toBe(false);
  expect(matchesRunnerLabels(["vectis-mac", "Linux"], "macos", "mac")).toBe(false);
  expect(matchesRunnerLabels(["vectis-mac", "gpu"], "macos", "mac")).toBe(false);
});
