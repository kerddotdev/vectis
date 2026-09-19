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
        label: "Get started",
        items: [
          { label: "Install Vectis", root: "get-started/install" },
          { label: "Quickstart", root: "get-started/quickstart" },
        ],
      },
      {
        label: "Environments",
        items: [
          { label: "Prepare Ubuntu", root: "guides/linux-setup" },
          { label: "Install macOS", root: "guides/macos-setup" },
          { label: "Install Windows (experimental)", root: "guides/windows-setup" },
          { label: "Storage and resources", root: "guides/storage" },
        ],
      },
      {
        label: "Guides",
        items: [
          { label: "Repositories and labels", root: "guides/repositories" },
          { label: "Runners and jobs", root: "guides/runners" },
          { label: "Workflow migration", root: "guides/migrations" },
          { label: "The Vectis app", root: "guides/app" },
          { label: "Your account", root: "guides/account" },
          { label: "Remote control", root: "guides/remote-control" },
          { label: "Agents", root: "guides/agents" },
          { label: "Troubleshooting", root: "guides/troubleshooting" },
        ],
      },
      {
        label: "Reference",
        items: [
          { label: "CLI reference", root: "reference/cli" },
          { label: "Operations and output", root: "reference/operations" },
        ],
      },
      {
        label: "Self-hosting",
        items: [
          { label: "Build from source", root: "self-hosting/build-from-source" },
          { label: "Package and sign", root: "self-hosting/packaging" },
          { label: "Run your own cloud", root: "self-hosting/cloud" },
          {
            label: "Private development environment",
            root: "self-hosting/development-environment",
          },
        ],
      },
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
