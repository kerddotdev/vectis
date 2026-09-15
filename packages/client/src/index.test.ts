import { createServer } from "node:http";
import { expect, test } from "vitest";
import { VectisClient } from "./index.js";

test("cancelling an operation wait aborts its in-flight HTTP request", async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address.");
  const client = new VectisClient({
    url: `http://127.0.0.1:${address.port}`,
    token: "isolated-test",
  });
  try {
    await expect(client.wait("operation", AbortSignal.timeout(50))).rejects.toMatchObject({
      code: "wait_cancelled",
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
