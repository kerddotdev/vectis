# Vectis

Vectis runs repository-scoped GitHub Actions runners in disposable local virtual machines. A local background service owns processes, virtual machines, credentials, and durable execution state. The desktop app, CLI, and MCP server are clients of the same local contract. A Convex backend owns cloud identity, the GitHub App, and remote commands. CI execution always stays on the host.

## What we never compromise on

### 1. The host stays in charge

Vectis runs untrusted CI code on someone's own machine. Guests never receive host directories, host Docker sockets, or broad host credentials by default. The GitHub App private key stays in the cloud. Repository IDs and installation access establish authority; labels, names, and display strings never do. Forks never inherit upstream runner capacity, and approving external pull requests stays a GitHub maintainer decision, never an automatic Vectis action.

### 2. Honest state

Accepted, running, action-required, and completed are different states. Never report an external effect (a booted VM, a registered runner, a finished job, a published pull request) before observing it. After a crash, reconcile durable state before retrying effects. Every surface shows the service's real state, including unsupported and action-required states.

### 3. Own what you start

The service stops only processes and process groups it started and tracks. Cancellation and failure release every owned timer, process, file, and subscription. Retained output and concurrent work are bounded.

### 4. One contract, every surface

Desktop, CLI, MCP, and remote control through the cloud all speak the same typed `Command` contract. A feature that works on one surface and is missing or behaves differently on another is a bug.

## How we work

Prefer ambitious ideas and simple systems. Do not preserve complexity just because it exists, and do not add machinery because it looks impressive. Find the real constraint, then build the smallest model that makes the correct behavior unsurprising. Channel both "measure twice, cut once" and "yagni".

Treat this document as good defaults, not hard rules. The developer's instructions override it. If a rule here fights the task in front of you, say so and get a human sign-off before breaking it.

## A small glossary

- **you** means the agent reading this file and changing Vectis.
- **maintainers** means the people building Vectis.
- **user** means the person running Vectis on their own machine.
- **host** means the machine that runs the local service and its VMs.
- **home** means the service data directory: `--home`, then `VECTIS_HOME`, then `~/.vectis`. It holds `state.sqlite`, `connection.json` (loopback URL and bearer token), `service.log`, and cloud credentials metadata.
- **environment** means a prepared Linux, macOS, or Windows guest image with its default CPU, memory, and storage settings.
- **instance** means one disposable VM cloned from an environment.
- **runner** means an ephemeral GitHub Actions just-in-time runner registered inside an instance.
- **operation** means a durable, idempotent unit of work keyed by the caller: `accepted`, `running`, `action_required`, `succeeded`, `failed`, or `cancelled`.
- **machine** means a host registered with the cloud. A **controller** is a remote client authorized to control a machine. A **binding** connects a GitHub repository to a machine and environment.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or kill a PID found by matching a name or path. Your own agent and other Vectis processes share those strings. Kill only a PID you captured at spawn.
2. **Touching the real install.** The CLI, MCP server, and development desktop all default to the real `~/.vectis`. Always pass `--home` or set `VECTIS_HOME` to a temporary directory. Never run `service install`, `uninstall`, or `update` against a real home: they manage per-user LaunchAgents (`dev.kerd.vectis.*`). Never read or write `sh.vectis.machine` Keychain items, and never pair or log in against a cloud deployment unless asked.
3. **Filling the disk.** Linux preparation, macOS restore images, Windows installation, and instance clones download or allocate many gigabytes. Do not start them, and do not boot real VMs, unless the developer asks.

## Hit every surface

Before calling a change done, walk this list and say which entries applied:

- **Contract.** Commands are variants of `Command` in `packages/protocol/src/index.ts` and are listed in `capabilities`. Read-only remote queries go through `LocalQuery` in `packages/protocol/src/controller.ts`.
- **Service.** `apps/server/src/service.ts` handles each command; local HTTP endpoints live in `apps/server/src/http.ts` with a matching `VectisClient` method in `packages/client/src/index.ts`.
- **Cloud.** Cloud-backed commands go through `packages/client/src/cloud-relay.ts` and a Convex function in `convex/`. Regenerate `convex/_generated` after changing Convex functions.
- **CLI.** Help text and parsing in `apps/cli/src/main.ts`. The help text also generates the public CLI reference.
- **Desktop.** `apps/desktop/src/renderer/lib/operations.ts` (labels, cancellable and preparation commands) and the relevant view in `apps/desktop/src/renderer/views`.
- **MCP.** `vectis_command` derives its schema from `Command` and usually needs no change. New tools belong in `apps/mcp/src/server.ts`.
- **Remote control.** Remote commands replay locally through `packages/client/src/remote-operation.ts`. Check that the command behaves correctly when submitted remotely.
- **Guest OS.** Linux, macOS, and Windows guests differ. Guest-shaped features need a decision per OS, even if it is "not supported".
- **Reverse states.** A way in needs a way out: connect needs disconnect, start needs cancel, prepare needs resume or discard.
- **Docs.** Update `apps/docs/docs/guides` and `skills/vectis/SKILL.md` when behavior they describe changes.

## Development

- Node 24 and pnpm (`packageManager` in `package.json`) with the committed lockfile. `pnpm install` installs.
- `pnpm build` compiles the headless apps, packages, Convex code, and scripts into `dist/`. Anything run from `dist/` needs a fresh build.
- `pnpm vectis --help` runs the built CLI. `pnpm mcp` runs the built MCP server. Pass `--home "$(mktemp -d)"`.
- `pnpm desktop:start` launches the development desktop (`Vectis Dev`) with a standalone Node runtime for the background service. Set `VECTIS_HOME` first.
- `pnpm web:dev` runs the Astro website. `pnpm docs:dev` runs the Blume documentation. `pnpm site:build` builds both and stages them into `apps/web/site` with the docs under `/docs`.
- Web, docs, and desktop builds download General Sans from Fontshare into the gitignored `packages/design/fonts`. Its license forbids committing the font files. `VECTIS_ALLOW_FONT_FALLBACK=1` builds without them.
- The Swift helpers live in `native/apple`: `swift build --package-path native/apple`, then ad-hoc sign `vectis-vm` with `native/apple/entitlements.plist`. QEMU build notes are in `native/qemu/README.md`.
- Convex runs with `pnpm exec convex dev` against your own deployment. The web app needs `VITE_CONVEX_URL` and `VITE_CLERK_PUBLISHABLE_KEY` (see `apps/web/.env.example`).
- Never deploy (Convex, Cloudflare, `site:deploy:dev`) or publish packages unless asked.

## Verifying

- Smallest proof that the change works: `pnpm exec vitest run <files>` for the tests you touched, plus `pnpm typecheck` or `pnpm lint` when types or lint rules are affected. `pnpm check` runs format, lint, typecheck, and tests together.
- Tests are colocated `*.test.ts` files; Convex tests live in `tests/convex` and use `convex-test`.
- Every test uses its own temporary home (`mkdtemp`) and synthetic data. Stub launchd, the Keychain, and cloud deployments the way existing tests do.
- Test authentication, ownership, failure recovery, migration preservation, and real protocol boundaries. Do not add tests that only mirror the implementation or assert static UI markup.
- Native VM runs and real GitHub job evidence are reported separately from synthetic tests. Never claim a VM boot, a GitHub job, signing, or a deployment without evidence.

## Pull requests

- Never open a PR unless the developer asks.
- Conventional commit titles in plain language: `fix(runner): release capacity while guest setup waits`.
- Body: the problem in a sentence or two, then how you fixed it.
- One concern per PR. If the description says "also", split it.
- Implementation never authorizes merging, publishing releases, or deploying.

## How it works

Clients reach the service over an authenticated loopback HTTP API: `127.0.0.1`, a random port, and a bearer token in the home's `connection.json`. Cross-origin browser requests are rejected. Commands become durable operations in SQLite, keyed for idempotency, and the runner package supervises VMs, disks, and guest processes. When a host is paired with the cloud, the service keeps an outgoing authenticated relay to Convex: remote commands arrive through it and replay locally under the same idempotency rules, and GitHub webhooks, runner leases, and job state flow through Convex. The host never exposes an inbound port.

## Where code lives

- `apps/server` - local service: HTTP API, SQLite store, command dispatch, image preparation, cloud relay startup.
- `apps/cli`, `apps/mcp` - headless control surfaces.
- `apps/desktop` - Electron shell and React renderer over the shared local client.
- `apps/web` - Astro website, the browser `/connect` account page, and a Cloudflare Worker that proxies GitHub callbacks to Convex.
- `apps/docs` - public Blume documentation. Public Markdown lives only in `apps/docs/docs`; the CLI reference is generated from the built CLI help.
- `packages/protocol` - Effect Schema contracts shared by every surface and Convex. No runtime logic.
- `packages/client` - local and remote clients, cloud relay, pairing, Keychain and LaunchAgent helpers.
- `packages/runner` - VM runtime and supervision, QEMU, the Apple helper bridge, guest preparation, storage inspection.
- `packages/github`, `packages/migration` - GitHub App contracts, job and runner logic, workflow migration previews.
- `packages/design` - design tokens, fonts, and the shared site header and footer.
- `convex` - cloud identity, authorization, GitHub integration, and remote operations.
- `native/apple`, `native/qemu` - Apple virtualization and Keychain helpers, QEMU build notes.
- `scripts` - docs generation, site staging, packaging, and verification. `tests/convex` - Convex tests.
- `skills/vectis` - portable agent guidance for using Vectis.

## Taste

- Small cohesive modules, strict types, inferred local types. No `any`, unchecked casts, or speculative frameworks.
- Imports between workspace packages use relative paths to `src`, except `@vectis/design`.
- Comments explain non-obvious constraints only.
- Tracked content is English, with ASCII hyphens only and no emojis.
- Command inputs are data, never shell text.
- Add a package only for a responsibility that is actually implemented.

## Interface

- Restrained, spacious, accessible, and keyboard usable. No pure black or white primary surfaces or text.
- Use the tokens in `packages/design`, not raw colors. Copper marks brand and interaction only. Job and operation states use their own status colors with an icon and a label.
- Body text uses the system font, headings use General Sans, and code, paths, and logs use Fragment Mono.
- Animate only transform and opacity, run entrance motion once, respect reduced motion, and avoid continuous decorative animation.
- Marketing copy states only verified behavior.
