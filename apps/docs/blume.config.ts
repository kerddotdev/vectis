import { defineConfig } from "blume";

const generalSans = {
  name: "General Sans",
  fallback: "sans",
  variants: [
    {
      src: "../../packages/design/fonts/general-sans/GeneralSans-Variable.woff2",
      weight: "200..700",
      style: "normal",
    },
    {
      src: "../../packages/design/fonts/general-sans/GeneralSans-VariableItalic.woff2",
      weight: "200..700",
      style: "italic",
    },
  ],
} as const;

const fragmentMono = "../../packages/design/node_modules/@fontsource/fragment-mono/files";

export default defineConfig({
  title: "Vectis",
  description: "Local virtual machines for GitHub Actions, controlled by people and agents.",
  logo: "/icon.svg",
  content: { root: "docs" },
  feedback: false,
  github: { owner: "kerddotdev", repo: "vectis", branch: "main", dir: "apps/docs" },
  theme: {
    mode: "system",
    radius: "lg",
    accent: { light: "oklch(45.7% 0.1 39.1)", dark: "oklch(81.8% 0.078 63.2)" },
    fonts: {
      display: generalSans,
      body: generalSans,
      mono: {
        name: "Fragment Mono",
        fallback: "mono",
        variants: [
          { src: `${fragmentMono}/fragment-mono-latin-400-normal.woff2`, weight: 400 },
          {
            src: `${fragmentMono}/fragment-mono-latin-400-italic.woff2`,
            weight: 400,
            style: "italic",
          },
        ],
      },
    },
  },
  markdown: {
    codeBlocks: { theme: { light: "vitesse-light", dark: "vitesse-dark" } },
  },
  navigation: {
    sidebar: [
      { label: "Start here", root: "index" },
      {
        label: "Guides",
        items: [
          { label: "Local setup", root: "guides/local-setup" },
          { label: "Prepare Linux", root: "guides/linux-setup" },
          { label: "Install macOS", root: "guides/macos-setup" },
          { label: "Install Windows", root: "guides/windows-setup" },
          { label: "Desktop", root: "guides/desktop" },
          { label: "Remote control", root: "guides/remote-control" },
          { label: "GitHub connections", root: "guides/github" },
          { label: "Run a runner", root: "guides/runners" },
          { label: "Workflow migration", root: "guides/migrations" },
          { label: "VM storage and resources", root: "guides/storage" },
          { label: "Agent integration", root: "guides/agents" },
        ],
      },
      {
        label: "Self-hosting",
        items: [
          { label: "Run your own cloud", root: "self-hosting/cloud" },
          {
            label: "Private development environment",
            root: "self-hosting/development-environment",
          },
        ],
      },
      { label: "Reference", items: [{ label: "CLI reference", root: "reference/cli" }] },
    ],
  },
  ai: {
    mcp: { enabled: false },
    webmcp: false,
  },
  deployment: {
    output: "static",
    site: "https://vectis.kerd.dev",
    base: "/docs",
  },
});
