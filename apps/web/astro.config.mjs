import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwind from "@tailwindcss/vite";

// Same files and names as the desktop, CLI and MCP builds: .env.local for development,
// .env.production.local for production. Process environment variables take precedence.
const flavor = process.env.VECTIS_FLAVOR === "production" ? "production" : "development";
function localEnvironment() {
  const file = new URL(
    flavor === "production" ? "../../.env.production.local" : "../../.env.local",
    import.meta.url,
  );
  try {
    return parseEnv(readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}
const local = localEnvironment();
const variable = (name) => process.env[name] ?? local[name] ?? "";

export default defineConfig({
  site: "https://vectis.kerd.dev",
  trailingSlash: "never",
  build: { format: "directory" },
  integrations: [react(), sitemap({ filter: (page) => !page.includes("/connect") })],
  vite: {
    plugins: [tailwind()],
    define: {
      "import.meta.env.VECTIS_CONVEX_URL": JSON.stringify(variable("CONVEX_URL")),
      "import.meta.env.VECTIS_CLERK_PUBLISHABLE_KEY": JSON.stringify(
        variable("CLERK_PUBLISHABLE_KEY"),
      ),
    },
  },
});
