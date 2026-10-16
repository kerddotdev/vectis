import { defineConfig } from "vitest/config";

// CI shares the host with real VMs, so service suites need more than the 5 second default.
export default defineConfig({ test: { testTimeout: 15000 } });
