import { expect, test } from "vitest";
import { resolveCloudDeployment, validateCloudUrl } from "./deployment.js";

const packaged = {
  flavor: "production" as const,
  cloudUrl: "https://cloud.vectis.test",
  webUrl: "https://vectis.test",
};

test("packaged builds ignore deployment variables from the user's environment", () => {
  expect(
    resolveCloudDeployment({
      packaged,
      environment: { VECTIS_CLOUD_URL: "https://other.test", VECTIS_WEB_URL: "https://x.test" },
      local: {},
    }),
  ).toEqual({ cloudUrl: packaged.cloudUrl, webUrl: packaged.webUrl });
});

test("source checkouts prefer the environment over .env.local", () => {
  expect(
    resolveCloudDeployment({
      packaged: undefined,
      environment: { VECTIS_CLOUD_URL: "https://env.test" },
      local: { VECTIS_CLOUD_URL: "https://file.test", VECTIS_WEB_URL: "https://dev.test" },
    }),
  ).toEqual({ cloudUrl: "https://env.test", webUrl: "https://dev.test" });
});

test("missing or malformed deployments are reported, never guessed", () => {
  expect(() => resolveCloudDeployment({ packaged: undefined, environment: {}, local: {} })).toThrow(
    "no cloud deployment",
  );
  for (const cloudUrl of ["https://cloud.test/path", "ftp://cloud.test", "https://user@cloud.test"])
    expect(() =>
      resolveCloudDeployment({
        packaged: undefined,
        environment: { VECTIS_CLOUD_URL: cloudUrl, VECTIS_WEB_URL: "https://dev.test" },
        local: {},
      }),
    ).toThrow("VECTIS_CLOUD_URL");
  expect(() =>
    resolveCloudDeployment({
      packaged: undefined,
      environment: { VECTIS_CLOUD_URL: "https://cloud.test", VECTIS_WEB_URL: "https://dev.test/" },
      local: {},
    }),
  ).toThrow("VECTIS_WEB_URL");
});

test("only development builds may use a loopback HTTP cloud", () => {
  expect(validateCloudUrl("http://127.0.0.1:8787", "development")).toBe("http://127.0.0.1:8787");
  expect(() => validateCloudUrl("http://127.0.0.1:8787", "production")).toThrow();
  expect(() => validateCloudUrl("http://cloud.test", "development")).toThrow();
});
