import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://vectis.kerd.dev",
  base: "/docs",
  integrations: [
    starlight({
      title: "Vectis",
      logo: {
        light: "../../assets/brand/web/vectis-light.svg",
        dark: "../../assets/brand/web/vectis.svg",
      },
      favicon: "/brand/vectis.svg",
      description: "Run GitHub Actions on your own machines.",
      customCss: ["./src/styles.css"],
      sidebar: [
        { label: "Start here", slug: "index" },
        { label: "Local setup", slug: "guides/local-setup" },
        { label: "Prepare Linux", slug: "guides/linux-setup" },
        { label: "Install macOS", slug: "guides/macos-setup" },
        { label: "Install Windows", slug: "guides/windows-setup" },
        { label: "Desktop", slug: "guides/desktop" },
        { label: "Remote control", slug: "guides/remote-control" },
        { label: "GitHub connections", slug: "guides/github" },
        { label: "Run a runner", slug: "guides/runners" },
        { label: "Workflow migration", slug: "guides/migrations" },
        { label: "VM storage and resources", slug: "guides/storage" },
        { label: "Agent integration", slug: "guides/agents" },
        { label: "CLI reference", slug: "reference/cli" },
      ],
    }),
  ],
});
