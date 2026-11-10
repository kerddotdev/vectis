import { expect, test, vi } from "vitest";
import { createCloudApi } from "./cloud-api.js";
const connection = {
  deploymentUrl: "https://cloud.example",
  machineId: "machine1",
  localId: "local1",
};
const credentials = { get: async () => "s".repeat(43) };
const signal = new AbortController().signal;
test("posts authenticated JSON and validates the route response", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
  const api = createCloudApi(connection, credentials, fetcher);
  expect(await api.call("/machine/jobs/list", { bindingId: "binding1" }, signal)).toEqual([]);
  expect(fetcher).toHaveBeenCalledWith(
    "https://cloud.example/machine/jobs/list",
    expect.objectContaining({
      method: "POST",
      redirect: "error",
      body: '{"bindingId":"binding1"}',
      headers: expect.objectContaining({ Authorization: `Bearer machine1.${"s".repeat(43)}` }),
    }),
  );
  fetcher.mockResolvedValueOnce(Response.json({ invalid: true }));
  await expect(api.call("/machine/jobs/list", { bindingId: "binding1" }, signal)).rejects.toThrow();
});
test.each([
  [401, { code: "machine_unauthorized" }, "machine_unauthorized"],
  [403, { code: "scale_set_unavailable", status: 401 }, "scale_set_auth_failed"],
  [409, { code: "operation_cancelled" }, "operation_cancelled"],
  [403, { code: "actor_not_allowed" }, "actor_not_allowed"],
])("maps structured errors (%s)", async (status, body, code) => {
  const api = createCloudApi(
    connection,
    credentials,
    vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status })),
  );
  await expect(api.call("/machine/github/accounts", {}, signal)).rejects.toMatchObject({ code });
});
test("missing credentials and unavailable upstream are distinguished", async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));
  await expect(
    createCloudApi(connection, { get: async () => null }, fetcher).call(
      "/machine/github/accounts",
      {},
      signal,
    ),
  ).rejects.toMatchObject({ code: "machine_revoked" });
  expect(fetcher).not.toHaveBeenCalled();
  await expect(
    createCloudApi(connection, credentials, fetcher).call("/machine/github/accounts", {}, signal),
  ).rejects.toMatchObject({ code: "cloud_unavailable" });
  fetcher.mockResolvedValue(new Response("unavailable", { status: 503 }));
  await expect(
    createCloudApi(connection, credentials, fetcher).call("/machine/github/accounts", {}, signal),
  ).rejects.toMatchObject({ code: "cloud_unavailable" });
});
