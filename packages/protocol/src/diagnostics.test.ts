import { Schema } from "effect";
import { expect, test } from "vitest";
import { Diagnostics } from "./diagnostics.js";

const legacyReport = {
  source: "service",
  host: { platform: "darwin", arch: "arm64", cpus: 8, memoryMiB: 16384 },
  supportedHost: true,
  configured: {
    appleHelper: true,
    qemu: false,
    qemuImg: false,
    swtpm: false,
    keychainHelper: true,
  },
  home: "/synthetic/vectis-home",
};

test("doctor accepts reports from services without detailed checks", () => {
  const report = Schema.decodeUnknownSync(Diagnostics)(legacyReport);
  expect(report).toEqual(legacyReport);
  expect(report.checks).toBeUndefined();
});

test("doctor preserves detailed checks and validates them when present", () => {
  const report = { ...legacyReport, checks: [{ id: "host", status: "ok", message: "Supported." }] };
  expect(Schema.decodeUnknownSync(Diagnostics)(report)).toEqual(report);
  expect(Schema.decodeUnknownSync(Diagnostics)({ ...legacyReport, checks: [] }).checks).toEqual([]);
  expect(() =>
    Schema.decodeUnknownSync(Diagnostics)({
      ...legacyReport,
      checks: [{ id: "host", status: "invalid", message: "Invalid." }],
    }),
  ).toThrow();
});
