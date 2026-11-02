import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { macosFilteredCaBundleScript, runnerStartScript } from "./runner-release.js";

const fixture = (name: string) =>
  readFile(fileURLToPath(new URL(`./fixtures/ca/${name}.pem`, import.meta.url)), "utf8");
const access = { repositoryId: 2, actors: "any", approval: "automatic" } as const;
const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

describe.skipIf(!hasOpenssl)("macOS guest CA bundle (requires openssl on PATH)", () => {
  let dir: string;
  let gate: string;
  let source: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vectis-ca-"));
    gate = join(dir, "gate");
    source = join(dir, "cert.pem");
    spawnSync("mkdir", ["-m", "700", gate]);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const run = () =>
    spawnSync(
      "bash",
      [
        "-c",
        `set -eu\numask 077\ngate='${gate}'\n${macosFilteredCaBundleScript(source, "openssl")}printf '%s\\n%s\\n%s\\n' "$SSL_CERT_FILE" "$CURL_CA_BUNDLE" "$GIT_SSL_CAINFO"`,
      ],
      { encoding: "utf8" },
    );

  test("drops both eMudhra roots, keeps the rest privately and exports the bundle", async () => {
    const [emsign, aaa, one, two] = await Promise.all(
      ["emsign-ecc-root-g3", "aaa-certificate-services", "ordinary-one", "ordinary-two"].map(
        fixture,
      ),
    );
    await writeFile(source, [one, emsign, two, aaa].join(""));
    const bundle = join(gate, "ca-bundle.pem");
    for (const attempt of [1, 2]) {
      const result = run();
      expect(result.status, `attempt ${attempt}: ${result.stderr}`).toBe(0);
      expect(result.stdout.split("\n").slice(0, 3)).toEqual([bundle, bundle, bundle]);
      expect(await readFile(bundle, "utf8")).toBe(one! + two!);
      expect((await stat(bundle)).mode & 0o777).toBe(0o600);
      expect(await readdir(gate)).toEqual(["ca-bundle.pem"]);
    }
  });

  test("fails closed and leaves no bundle when only blocked roots remain", async () => {
    await writeFile(
      source,
      (await fixture("emsign-ecc-root-g3")) + (await fixture("aaa-certificate-services")),
    );
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("vectis: macOS guest CA bundle: no certificates remain");
    expect(await readdir(gate)).toEqual([]);
  });

  test("fails when the source is missing", async () => {
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot read");
    expect(await readdir(gate)).toEqual([]);
  });

  test("fails when a certificate block is corrupt", async () => {
    const one = await fixture("ordinary-one");
    await writeFile(
      source,
      one + "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydA==\n-----END CERTIFICATE-----\n",
    );
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot fingerprint");
    expect(await readdir(gate)).toEqual([]);
  });
});

test("only macOS start scripts filter the CA bundle", () => {
  for (const os of ["linux", "windows"] as const)
    expect(runnerStartScript(os, "c2VjcmV0", access)).not.toContain("ca-bundle.pem");
  expect(runnerStartScript("macos", "c2VjcmV0", access)).toContain("ca-bundle.pem");
});
