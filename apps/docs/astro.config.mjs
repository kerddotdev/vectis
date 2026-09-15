import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://vectis.kerd.dev",
  base: "/docs",
  integrations: [
    starlight({
      title: "Vectis",
      description: "Run GitHub Actions on your own machines.",
      customCss: ["./src/styles.css"],
      sidebar: [
        { label: "Start here", slug: "index" },
        { label: "Local setup", slug: "guides/local-setup" },
        { label: "VM storage and resources", slug: "guides/storage" },
        { label: "Agent integration", slug: "guides/agents" },
        { label: "CLI reference", slug: "reference/cli" },
      ],
    }),
  ],
});
