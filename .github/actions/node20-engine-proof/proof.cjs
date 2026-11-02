const assert = require("node:assert/strict");
const https = require("node:https");

async function probe(url) {
  return new Promise((resolve) => {
    const request = https.get(url, { timeout: 20000 }, (response) => {
      response.resume();
      resolve({ url, accepted: true, status: response.statusCode });
    });
    request.on("timeout", () => request.destroy(new Error("request_timeout")));
    request.on("error", (error) =>
      resolve({ url, accepted: false, code: error.code, message: error.message }),
    );
  });
}

async function main() {
  const expectedMajor = Number(process.argv[2] || 24);
  const runtime = {
    node: process.version,
    openssl: process.versions.openssl,
    executable: process.execPath,
    expectedMajor,
    releaseBase: process.env.RELEASE_BASE_SHA,
    diagnosticCommit: process.env.GITHUB_SHA,
    runnerName: process.env.RUNNER_NAME,
    runnerOS: process.env.RUNNER_OS,
    runnerArch: process.env.RUNNER_ARCH,
    tlsEnvironmentPresent: Object.fromEntries(
      ["NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE"].map(
        (key) => [key, process.env[key] !== undefined],
      ),
    ),
  };
  console.log(JSON.stringify({ runtime }));
  assert.equal(Number(process.versions.node.split(".")[0]), expectedMajor);
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0");
  const positive = await probe("https://github.com/");
  console.log(JSON.stringify({ positive }));
  assert.equal(positive.accepted, true);
  assert.equal(positive.status, 200);
  if (expectedMajor === 20) {
    const negative = [];
    for (const url of [
      "https://dv-g3b-emudhra.we-have-a-problem.com/",
      "https://dv-g3b-aaa-emudhra.we-have-a-problem.com/",
    ]) {
      const result = await probe(url);
      negative.push(result);
      console.log(JSON.stringify({ negativeTLS: result }));
      if (result.accepted)
        console.log(`::warning::Node20 accepted compromised-chain endpoint ${url}; security proof FAILED.`);
    }
    console.log(JSON.stringify({
      compatibility: "pass",
      negativeTLS: negative,
      securityProof: negative.every((result) =>
        !result.accepted && /CERT|ISSUER|VERIFY|SELF_SIGNED/.test(result.code || ""),
      ) ? "certificate-rejection-observed" : "failed-or-inconclusive",
    }));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
