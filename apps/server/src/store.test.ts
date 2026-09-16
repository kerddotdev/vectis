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

test("inactive setup prompts do not reserve capacity but unconfirmed guest processes do", () => {
  const store = new Store(":memory:");
  try {
    store.put("macInstallation", "mac", { phase: "setup_required" });
    store.put("preparation", "linux", { phase: "interrupted" });
    expect(store.snapshot().preparationBusy).toBe(false);
    for (const phase of ["installing", "setup_running"]) {
      store.put("macInstallation", "mac", { phase });
      expect(store.snapshot().preparationBusy).toBe(true);
    }
    store.put("macInstallation", "mac", { phase: "registered" });
    store.put("preparation", "linux", { phase: "booting" });
    expect(store.snapshot().preparationBusy).toBe(true);
    store.put("preparation", "linux", { phase: "prepared" });
    expect(store.snapshot().preparationBusy).toBe(false);
  } finally {
    store.close();
  }
});
