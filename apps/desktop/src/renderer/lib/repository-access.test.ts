import { describe, expect, it } from "vitest";
import {
  addActorId,
  canSaveAccess,
  defaultAccess,
  maxActorIds,
  parseGitHubId,
  sameAccess,
} from "./repository-access";

describe("parseGitHubId", () => {
  it("accepts positive safe integers only", () => {
    expect(parseGitHubId(" 583231 ")).toBe(583231);
    for (const text of ["", "0", "-4", "1.5", "12a", "0x10", "9007199254740993"])
      expect(parseGitHubId(text)).toBeUndefined();
  });
});

describe("addActorId", () => {
  it("rejects duplicates, invalid text and a full list", () => {
    expect(addActorId([1], "2")).toEqual({ ids: [1, 2] });
    expect(addActorId([1], "1")).toHaveProperty("error");
    expect(addActorId([], "octocat")).toHaveProperty("error");
    const full = Array.from({ length: maxActorIds }, (_, index) => index + 1);
    expect(addActorId(full, "500")).toHaveProperty("error");
  });
});

describe("access changes", () => {
  it("ignores id order and detects real changes", () => {
    const saved = { actors: { ids: [1, 2] }, approval: "required" } as const;
    expect(sameAccess(saved, { actors: { ids: [2, 1] }, approval: "required" })).toBe(true);
    expect(canSaveAccess(saved, { actors: { ids: [2, 1] }, approval: "required" })).toBe(false);
    expect(canSaveAccess(saved, { actors: { ids: [1] }, approval: "required" })).toBe(true);
    expect(canSaveAccess(saved, { ...saved, approval: "automatic" })).toBe(true);
  });

  it("treats an empty user list as unsaveable", () => {
    expect(canSaveAccess(defaultAccess, { actors: { ids: [] }, approval: "automatic" })).toBe(
      false,
    );
    expect(canSaveAccess(defaultAccess, { actors: "any", approval: "required" })).toBe(true);
  });
});
