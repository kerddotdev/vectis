import { expect, test, vi } from "vitest";
import { credentialAccount, machineBearer } from "./machine-auth.js";

const connection = {
  deploymentUrl: "https://cloud.vectis.test",
  machineId: "machine",
  localId: "host",
};
const secret = "a".repeat(43);

test("credentials are bound to a deployment and machine", () => {
  expect(credentialAccount(connection)).not.toBe(
    credentialAccount({ ...connection, machineId: "another" }),
  );
  expect(credentialAccount(connection)).not.toBe(
    credentialAccount({ ...connection, deploymentUrl: "https://other.test" }),
  );
});

test("the bearer pairs the machine id with the stored secret", async () => {
  const get = vi.fn(async () => secret);
  expect(await machineBearer(connection, { get }, new AbortController().signal)).toBe(
    `machine.${secret}`,
  );
  expect(get).toHaveBeenCalledWith(credentialAccount(connection), expect.any(AbortSignal));
  expect(
    await machineBearer(connection, { get: async () => null }, new AbortController().signal),
  ).toBeNull();
  await expect(
    machineBearer(connection, { get: async () => "short" }, new AbortController().signal),
  ).rejects.toThrow("malformed");
});
