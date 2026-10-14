import { describe, expect, it } from "vitest";
import type { EnvironmentView } from "./environment-network";
import { initialDraft, networkChanges, networkDisplay } from "./environment-network";

const base = {
  id: "env",
  name: "Env",
  os: "linux",
  basePath: "/base",
  cpu: 4,
  memoryMiB: 8192,
  state: "ready",
} as const satisfies EnvironmentView;

describe("networkDisplay", () => {
  it("never claims internet only without enforcement", () => {
    const environment: EnvironmentView = {
      ...base,
      network: { egress: "internet_only", enforcement: "not_enforced" },
    };
    expect(networkDisplay(environment)).toEqual({
      tone: "attention",
      label: "Open, not restricted",
    });
  });

  it("shows enforced internet only and enforced open", () => {
    const windows = { ...base, os: "windows" } as const;
    expect(
      networkDisplay({ ...windows, network: { egress: "internet_only", enforcement: "enforced" } })
        ?.label,
    ).toBe("Internet only");
    expect(
      networkDisplay({ ...windows, network: { egress: "open", enforcement: "enforced" } })?.tone,
    ).toBe("attention");
  });

  it("shows nothing when the service reports no network state", () => {
    expect(networkDisplay(base)).toBeUndefined();
  });
});

describe("networkChanges", () => {
  it("sends nothing when unchanged", () => {
    expect(networkChanges(base, initialDraft(base))).toEqual({});
  });

  it("sends rosetta changes for Linux only", () => {
    expect(networkChanges(base, { ...initialDraft(base), rosetta: true })).toEqual({
      x64: "rosetta",
    });
    const enabled = { ...base, x64: "rosetta" } as const;
    expect(networkChanges(enabled, { ...initialDraft(enabled), rosetta: false })).toEqual({
      x64: "off",
    });
    const mac = { ...base, os: "macos" } as const;
    expect(networkChanges(mac, { ...initialDraft(mac), rosetta: true })).toEqual({});
  });

  it("sends egress changes for Windows only", () => {
    const windows = {
      ...base,
      os: "windows",
      network: { egress: "internet_only", enforcement: "enforced" },
    } as const;
    expect(networkChanges(windows, { ...initialDraft(windows), egress: "open" })).toEqual({
      egress: "open",
    });
    expect(networkChanges(base, { ...initialDraft(base), egress: "internet_only" })).toEqual({});
  });
});
