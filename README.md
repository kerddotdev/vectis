# Vectis

GitHub Actions runners on your own machines, with a shared control interface for the desktop, CLI, and agents. VM execution stays local; the central service coordinates identity and commands.

This is a development build, not an installable runner product yet. Start with the [local setup guide](apps/docs/src/content/docs/guides/local-setup.md). It distinguishes working controls from guest setup and GitHub integration that remain under development.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm vectis --help
```

Use Node 24.21 or newer within Node 24 and pnpm 10.24.0. Native VM execution requires an Apple Silicon Mac.

- [VM locations, disk usage, CPU and RAM](apps/docs/src/content/docs/guides/storage.md)
- [CLI, MCP and agent skill](apps/docs/src/content/docs/guides/agents.md)
- [Contributor conventions](AGENTS.md)

`pnpm check` runs formatting, lint, type checks, and tests. `pnpm docs:dev` opens the documentation development server; `pnpm docs:build` produces the static site and its Markdown/`llms.txt` output. `pnpm docs:deploy:dev` targets the separate Cloudflare development docs site and requires Wrangler authentication.
