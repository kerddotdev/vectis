import type { Env as CloudEnv } from "../src/env.js";

declare global {
  namespace Cloudflare {
    interface Env extends CloudEnv {
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    }
  }
}
