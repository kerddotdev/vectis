import { expect, test, vi } from "vitest";
import { bootstrapAdmin, tokenExpiration } from "./bootstrap.js";
import { ScaleSetAdminClient, type Fetch } from "./client.js";

const input = {
  owner: "kerdofficial",
  repo: "vectis-dev-sandbox",
  installationToken: "installation-secret",
};
const jwt = (payload: unknown) =>
  `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
const serviceUrl = "https://actions.example.test/tenant/repository/";
const name = "vectis-probe-test";
const labels = [name, "self-hosted", "Linux", "ARM64", "vectis-scaleset-probe"];
const set = {
  id: 17,
  name,
  runnerGroupId: 42,
  labels: labels.map((name) => ({ name, type: "System" })),
};

test("exchanges a repository registration token with RemoteAuth and retains only the admin connection", async () => {
  const token = jwt({ exp: 2000000000 });
  const fetch = vi
    .fn<Fetch>()
    .mockResolvedValueOnce(Response.json({ token: "registration-secret" }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ url: serviceUrl, token }));
  expect(await bootstrapAdmin(input, fetch)).toEqual({
    serviceUrl,
    adminToken: token,
    adminTokenExp: 2000000000,
  });
  expect(
    fetch.mock.calls.map(([url, init]) => [
      url.href,
      init.method,
      new Headers(init.headers).get("Authorization"),
    ]),
  ).toEqual([
    [
      "https://api.github.com/repos/kerdofficial/vectis-dev-sandbox/actions/runners/registration-token",
      "POST",
      "Bearer installation-secret",
    ],
    [
      "https://api.github.com/actions/runner-registration",
      "POST",
      "RemoteAuth registration-secret",
    ],
  ]);
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1].body))).toEqual({
    url: "https://github.com/kerdofficial/vectis-dev-sandbox",
    runner_event: "register",
  });
  for (const [, init] of fetch.mock.calls) {
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  }
});

test.each([401, 403, 422, 429, 500])(
  "bootstrap status %i is observable without leaking credentials or bodies",
  async (status) => {
    const fetch = vi.fn<Fetch>(
      async () => new Response("registration-secret installation-secret", { status }),
    );
    await expect(bootstrapAdmin(input, fetch)).rejects.toMatchObject({
      stage: "registration-token",
      status,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test("exchange errors identify their stage and are not retried", async () => {
  const fetch = vi
    .fn<Fetch>()
    .mockResolvedValueOnce(Response.json({ token: "registration-secret" }, { status: 201 }))
    .mockResolvedValueOnce(new Response("secret body", { status: 401 }));
  await expect(bootstrapAdmin(input, fetch)).rejects.toThrow(
    "Scale set bootstrap runner-registration failed (401).",
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});

test.each([
  { url: "http://actions.example.test", token: "secret" },
  { url: "https://user:secret@actions.example.test", token: "secret" },
  { url: "https://actions.example.test/?token=secret", token: "secret" },
  { url: "https://actions.example.test/#secret", token: "secret" },
  { token: "secret" },
  { url: serviceUrl, token: "" },
])("malformed bootstrap data is rejected with a redacted error", async (connection) => {
  const fetch = vi
    .fn<Fetch>()
    .mockResolvedValueOnce(Response.json({ token: "registration-secret" }, { status: 201 }))
    .mockResolvedValueOnce(Response.json(connection));
  await expect(bootstrapAdmin(input, fetch)).rejects.toThrow(
    "Invalid or unsupported scale set response.",
  );
});

test("bootstrap bounds response bodies and sanitizes fetch errors", async () => {
  await expect(
    bootstrapAdmin(input, async () => new Response("x".repeat(1024 * 1024 + 1), { status: 201 })),
  ).rejects.toThrow("Invalid or unsupported scale set response.");
  await expect(
    bootstrapAdmin(input, async () => {
      throw new Error("installation-secret");
    }),
  ).rejects.toThrow("Invalid or unsupported scale set response.");
});

test("bootstrap cancellation stops the exchange and unsafe repository paths never reach fetch", async () => {
  const fetch = vi.fn<Fetch>();
  const stop = new AbortController();
  stop.abort(new Error("stop bootstrap"));
  await expect(bootstrapAdmin(input, fetch, stop.signal)).rejects.toThrow("stop bootstrap");
  await expect(bootstrapAdmin({ ...input, repo: ".." }, fetch)).rejects.toThrow(
    "Invalid repository name.",
  );
  expect(fetch).not.toHaveBeenCalled();
});

test("expiry observation reads exp without claiming to authenticate a JWT", () => {
  expect(tokenExpiration(jwt({ exp: 2000000000, iat: 1999990000 }))).toBe(2000000000);
  for (const token of ["opaque", "a.bad-json.b", jwt({}), jwt({ exp: "2000" }), jwt({ exp: -1 })])
    expect(tokenExpiration(token)).toBeNull();
});

test("admin discovers the default group, finds or creates a set, reads effective labels, generates JIT, and deletes", async () => {
  const fetch = vi
    .fn<Fetch>()
    .mockResolvedValueOnce(
      Response.json({ count: 1, value: [{ id: 42, name: "Default", isDefaultGroup: true }] }),
    )
    .mockResolvedValueOnce(Response.json({ count: 0, value: [] }))
    .mockResolvedValueOnce(Response.json(set))
    .mockResolvedValueOnce(Response.json({ ...set, labels: set.labels.slice(0, 1) }))
    .mockResolvedValueOnce(
      Response.json({ runner: { id: 81, name: `${name}-runner` }, encodedJITConfig: "jit-secret" }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const admin = new ScaleSetAdminClient(serviceUrl, "admin-secret", fetch);
  expect((await admin.defaultRunnerGroup()).id).toBe(42);
  expect(await admin.findScaleSet(42, name)).toBeNull();
  expect(await admin.createScaleSet(42, name, labels)).toEqual(set);
  expect((await admin.getScaleSet(17)).labels).toEqual(set.labels.slice(0, 1));
  expect((await admin.generateJitConfig(17, `${name}-runner`)).encodedJITConfig).toBe("jit-secret");
  await admin.deleteScaleSet(17);
  expect(fetch.mock.calls.map(([url]) => url.pathname)).toEqual([
    "/tenant/repository/_apis/runtime/runnergroups/",
    "/tenant/repository/_apis/runtime/runnerscalesets",
    "/tenant/repository/_apis/runtime/runnerscalesets",
    "/tenant/repository/_apis/runtime/runnerscalesets/17",
    "/tenant/repository/_apis/runtime/runnerscalesets/17/generatejitconfig",
    "/tenant/repository/_apis/runtime/runnerscalesets/17",
  ]);
  expect(fetch.mock.calls[0]?.[0].searchParams.get("groupName")).toBe("default");
  expect(fetch.mock.calls[1]?.[0].searchParams.get("runnerGroupId")).toBe("42");
  expect(fetch.mock.calls[1]?.[0].searchParams.get("name")).toBe(name);
  expect(JSON.parse(String(fetch.mock.calls[2]?.[1].body))).toEqual({
    name,
    runnerGroupId: 42,
    labels: set.labels,
    RunnerSetting: { disableUpdate: true },
  });
  expect(JSON.parse(String(fetch.mock.calls[4]?.[1].body))).toEqual({
    name: `${name}-runner`,
    workFolder: "_work",
  });
  for (const [url, init] of fetch.mock.calls) {
    expect(url.searchParams.get("api-version")).toBe("6.0-preview");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer admin-secret");
  }
});

test("admin lookup rejects ambiguous, inconsistent and mismatched identities", async () => {
  for (const result of [
    { count: 2, value: [set, set] },
    { count: 0, value: [set] },
    { count: 1, value: [{ ...set, name: "other" }] },
  ]) {
    const admin = new ScaleSetAdminClient(serviceUrl, "admin", async () => Response.json(result));
    await expect(admin.findScaleSet(42, name)).rejects.toThrow(
      "Invalid or unsupported scale set response.",
    );
  }
  const admin = new ScaleSetAdminClient(serviceUrl, "admin", async () =>
    Response.json({ ...set, id: 18 }),
  );
  await expect(admin.getScaleSet(17)).rejects.toThrow("Invalid or unsupported scale set response.");
  await expect(
    new ScaleSetAdminClient(
      serviceUrl,
      "admin",
      async () => new Response(null, { status: 202 }),
    ).getScaleSet(17),
  ).rejects.toMatchObject({ status: 202 });
});
