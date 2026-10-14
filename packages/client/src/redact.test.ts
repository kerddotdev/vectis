import { expect, test } from "vitest";
import { redact } from "./redact.js";

const canary = "credentialCanary123456789";
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.c2lnbmF0dXJl";
const jit = Buffer.from(
  JSON.stringify({ ".runner": "runner-name", ".credentials": canary }),
).toString("base64");

test.each([
  [`Authorization: Bearer ${canary}`, "Authorization: Bearer [redacted]"],
  [`Authorization: Basic ${canary}`, "Authorization: Basic [redacted]"],
  [`authorization: token ${canary}`, "authorization: token [redacted]"],
  ...["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"].map((prefix) => [
    `failed ${prefix}${canary} exit 23`,
    "failed [redacted] exit 23",
  ]),
  [`jwt ${jwt}`, "jwt [redacted]"],
  [`jwt ${jwt} ${jwt}`, "jwt [redacted] [redacted]"],
  [`./run.sh --jitconfig '${jit}' exit 2`, "./run.sh --jitconfig '[redacted]' exit 2"],
  [`--jitconfig ${jit}`, "--jitconfig [redacted]"],
  [`jitconfig="${jit}"`, 'jitconfig="[redacted]"'],
  [`encoded ${jit}`, "encoded [redacted]"],
  [
    `password=${canary} secret='${canary}' token="${canary}"`,
    "password=[redacted] secret='[redacted]' token=\"[redacted]\"",
  ],
  ...[
    "token",
    "sig",
    "signature",
    "X-Amz-Signature",
    "X-Amz-Credential",
    "X-Amz-Security-Token",
    "X-Amz-Date",
    "code",
    "%74oken",
  ].map((key) => [
    `https://example.test/path?view=full&${key}=${canary}#trace`,
    `https://example.test/path?view=full&${key}=[redacted]#trace`,
  ]),
  [
    `https://example.test/path?code=${canary}&token=${canary}&page=2`,
    "https://example.test/path?code=[redacted]&token=[redacted]&page=2",
  ],
  ...["", "RSA ", "EC ", "DSA ", "OPENSSH ", "ENCRYPTED "].map((kind) => [
    `before\n-----BEGIN ${kind}PRIVATE KEY-----\n${canary}\n-----END ${kind}PRIVATE KEY-----\nafter`,
    "before\n[redacted]\nafter",
  ]),
  [`before\n-----BEGIN PRIVATE KEY-----\n${canary}`, "before\n[redacted]"],
  [`${canary}\n-----END PRIVATE KEY-----\nafter`, "[redacted]\nafter"],
])("redacts credentials while preserving diagnostic context: %s", (input, expected) => {
  if (input === undefined) throw new Error("Missing input");
  const output = redact(input);
  expect(output).toBe(expected);
  expect(output).not.toContain(canary);
  expect(redact(output)).toBe(output);
});

test("known values are literal, longest first, and short values do not destroy diagnostics", () => {
  const secret = "canary.$+[]()\\long";
  const text = `path /tmp/runner exit 23 host runner.local ${secret} ${secret}Long secret short`;
  const secrets = ["", "secret", "short", secret, secret + "Long", "redacted"];
  const output = redact(text, secrets);
  expect(output).toBe(
    "path /tmp/runner exit 23 host runner.local [redacted] [redacted] secret short",
  );
  expect(redact(output, secrets)).toBe(output);
});

test("ordinary paths, hosts, runner names, public keys and base64 JSON remain useful", () => {
  const ordinary = Buffer.from(JSON.stringify({ name: "runner.local", exitCode: 23 })).toString(
    "base64",
  );
  const text = `/tmp/runner C:\\Program Files\\MinGit runner.local runner-name exit 23 ssh-ed25519 AAAAC3Nz ${ordinary} https://example.test/path?page=2`;
  expect(redact(text)).toBe(text);
});

test("adversarial unterminated prefixes and many adjacent JWTs finish within a bounded time", () => {
  const text = "eyJ".repeat(350000) + "\n" + "-----BEGIN PRIVATE KEY-----\n".repeat(15000);
  const started = performance.now();
  expect(redact(text)).toBe("eyJ".repeat(350000) + "\n[redacted]");
  const adjacent = Array.from({ length: 20000 }, () => jwt).join(".");
  expect(redact(adjacent)).toBe(Array.from({ length: 20000 }, () => "[redacted]").join("."));
  expect(performance.now() - started).toBeLessThan(2500);
});

test("known values cannot obscure a credential pattern or alter the replacement marker", () => {
  const text = `-----BEGIN PRIVATE KEY-----\n${canary}\n-----END PRIVATE KEY-----\nAuthorization: Bearer ${canary}\n[redacted]suffix`;
  const secrets = ["PRIVATE KEY", "Authorization", "[redacte", "[redacted]suffix"];
  const output = redact(text, secrets);
  expect(output).toBe("[redacted]\n[redacted]: Bearer [redacted]\n[redacted]");
  expect(redact(output, secrets)).toBe(output);
});
