import { expect, test } from "vitest";
import { resolveCloudDeployment } from "./deployment.js";

const packaged = {
  flavor: "production" as const,
  convexUrl: "https://prod-1.convex.cloud",
  webUrl: "https://vectis.test",
};

test("packaged builds ignore deployment variables from the user's environment", () => {
  expect(
    resolveCloudDeployment({
      packaged,
      environment: { CONVEX_URL: "https://other-2.convex.cloud", VECTIS_WEB_URL: "https://x.test" },
      local: {},
    }),
  ).toEqual({ convexUrl: packaged.convexUrl, webUrl: packaged.webUrl });
});

test("source checkouts prefer the environment over .env.local", () => {
  expect(
    resolveCloudDeployment({
      packaged: undefined,
      environment: { CONVEX_URL: "https://env-1.convex.cloud" },
      local: { CONVEX_URL: "https://file-1.convex.cloud", VECTIS_WEB_URL: "https://dev.test" },
    }),
  ).toEqual({ convexUrl: "https://env-1.convex.cloud", webUrl: "https://dev.test" });
});

test("missing or malformed deployments are reported, never guessed", () => {
  expect(() => resolveCloudDeployment({ packaged: undefined, environment: {}, local: {} })).toThrow(
    "no cloud deployment",
  );
  expect(() =>
    resolveCloudDeployment({
      packaged: undefined,
      environment: { CONVEX_URL: "http://local.convex.cloud", VECTIS_WEB_URL: "https://dev.test" },
      local: {},
    }),
  ).toThrow("CONVEX_URL");
  expect(() =>
    resolveCloudDeployment({
      packaged: undefined,
      environment: {
        CONVEX_URL: "https://dev-1.convex.cloud",
        VECTIS_WEB_URL: "https://dev.test/",
      },
      local: {},
    }),
  ).toThrow("VECTIS_WEB_URL");
});
