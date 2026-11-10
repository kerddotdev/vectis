import { configDefaults, defineConfig } from "vitest/config";

// CI shares the host with real VMs, so service suites need more than the 5 second default.
// The cloud Worker's tests run inside workerd through their own project.
export default defineConfig({
  test: {
    testTimeout: 15000,
    projects: [
      {
        extends: true,
        test: { name: "node", exclude: [...configDefaults.exclude, "apps/cloud/**"] },
      },
      "apps/cloud/vitest.config.ts",
    ],
  },
});
