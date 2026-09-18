import { expect, test } from "vitest";
import { Store } from "./store.js";
test("recovery never silently retries an uncertain side effect", () => {
  const store = new Store(":memory:");
  try {
    const { operation } = store.accept("id", "fingerprint", "environment.start");
    store.update(operation, { status: "running" });
    store.recover();
    expect(store.snapshot().operations[0]?.status).toBe("action_required");
    expect(store.accept("id", "fingerprint", "environment.start").fresh).toBe(false);
  } finally {
    store.close();
  }
});
