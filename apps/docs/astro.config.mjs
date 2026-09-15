import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  integrations: [
    starlight({
      title: "Vectis",
      description: "Run GitHub Actions on your own machines.",
      customCss: ["./src/styles.css"],
      sidebar: [
        { label: "Start here", link: "/" },
        { label: "Local setup", link: "/guides/local-setup/" },
        { label: "VM storage and resources", link: "/guides/storage/" },
        { label: "Agent integration", link: "/guides/agents/" },
        { label: "CLI reference", link: "/reference/cli/" },
      ],
    }),
  ],
});
