import { expect, test } from "vitest";
import { windowsGit, windowsSeed } from "./windows-seed.js";

const configuration = {
  id: "isolated-setup",
  password: "Generated-local-test-password-42!",
  imageName: "Windows 11 Pro",
  acceptLicense: true,
};

test("Windows answer media requires explicit license acceptance and safe script identifiers", () => {
  expect(() => windowsSeed({ ...configuration, acceptLicense: false })).toThrow(/license terms/);
  expect(() => windowsSeed({ ...configuration, id: "'; Invoke-Expression '" })).toThrow();
  expect(() => windowsSeed({ ...configuration, password: "short" })).toThrow();
  expect(() => windowsSeed({ ...configuration, imageName: "Windows\u0000Pro" })).toThrow();
});

test("guest git is checked against its pinned hash before anything uses it", () => {
  const { script } = windowsSeed(configuration);
  const download = script.indexOf(windowsGit.url);
  const verify = script.indexOf(windowsGit.sha256);
  const use = script.indexOf("git.exe");
  expect(download).toBeGreaterThan(-1);
  expect(verify).toBeGreaterThan(download);
  expect(use).toBeGreaterThan(verify);
  expect(script).toContain("throw 'Git checksum mismatch'");
});

test("answer-file values cannot inject XML or leak the password into the bootstrap script", () => {
  const password = "Local<&\"'password-for-test-42!";
  const imageName = "Windows <edition> & example";
  const { answer, script } = windowsSeed({ ...configuration, password, imageName });
  expect(answer).toContain("Local&lt;&amp;&quot;&apos;password-for-test-42!");
  expect(answer).toContain("Windows &lt;edition&gt; &amp; example");
  expect(answer).not.toContain(password);
  expect(script).not.toContain(password);
  const command = answer.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1];
  expect(command).toBeDefined();
  const launch = Buffer.from(command ?? "", "base64").toString("utf16le");
  expect(launch).toContain("VECTIS_SETUP");
  expect(launch).not.toContain(password);
});
