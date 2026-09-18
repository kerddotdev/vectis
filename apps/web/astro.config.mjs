import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  site: "https://vectis.kerd.dev",
  trailingSlash: "never",
  build: { format: "directory" },
  integrations: [react(), sitemap({ filter: (page) => !page.includes("/connect") })],
  vite: { plugins: [tailwind()], envPrefix: "VITE_" },
});
