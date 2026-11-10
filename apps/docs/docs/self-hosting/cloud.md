---
title: Run your own cloud
description: Deploy the cloud Worker, Clerk sign-in, website, and GitHub App behind your own Vectis builds.
---

The hosted service at `vectis.kerd.dev` is one deployment of the code in this repository. You can run the same stack yourself, for a fork or for private development. A deployment has four parts:

| Part         | What it does                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Cloud Worker | `apps/cloud`: accounts, machines, repository connections, GitHub webhooks, runner leases, and remote commands, on D1 storage |
| Clerk        | Sign-in for the connect page                                                                                                 |
| Site Worker  | `apps/web`: serves the website, the docs, and `/connect`, and forwards GitHub browser callbacks to the cloud Worker          |
| GitHub App   | Repository access and just-in-time runner registration                                                                       |

Run the cloud Worker on the Workers Paid plan. Most requests stay under the Free plan's 10 ms CPU limit, but workflow migration previews and job scans parse whole workflow files and runs and take tens of milliseconds. Each connected Mac holds one WebSocket to its own Durable Object; keep-alive pings are answered without waking it, and the cloud only does work when something changes.

Vectis builds come in two flavors. **Development** builds (every source checkout) read `.env.local`, use `~/.vectis-dev`, and are named Vectis Dev. **Production** builds are packaged with `--flavor production`, read `.env.production.local` at package time, and use `~/.vectis`. Keep one set of Workers, D1 database, Clerk instance, and GitHub App per flavor; never point a development build at production data.

[`.env.example`](https://github.com/kerddotdev/vectis/blob/main/.env.example) lists every variable. Copy it to `.env.local` or `.env.production.local` and fill it in as you go. Commands below use the `development` Wrangler environment; use `--env production` and `.env.production.local` for production.

## 1. Cloud Worker

Sign in with `pnpm --filter @vectis/cloud exec wrangler login`. Create the D1 database and put its ID into the matching environment of `apps/cloud/wrangler.jsonc` (`database_id`):

```sh
pnpm --filter @vectis/cloud exec wrangler d1 create vectis-dev
```

Set the plain values in the same environment's `vars`: `VECTIS_WEB_URL` (the HTTPS origin of the site Worker from step 3, without a trailing slash), `VECTIS_CLOUD_URL` (this Worker's own origin), `CLERK_ISSUER` (step 2), `VECTIS_GITHUB_APP_NAME`, and `VECTIS_GITHUB_APP_PUBLIC`. Then apply the schema and deploy:

```sh
pnpm --filter @vectis/cloud exec wrangler d1 migrations apply DB --env development --remote
pnpm --filter @vectis/cloud exec wrangler deploy --env development
```

Put the Worker's origin into `VECTIS_CLOUD_URL` in `.env.local`. The production environment in `apps/cloud/wrangler.jsonc` routes `cloud.vectis.kerd.dev`; change it to your own domain in a fork.

For local work, `pnpm --filter @vectis/cloud exec wrangler d1 migrations apply DB --local` and `pnpm --filter @vectis/cloud dev` run the Worker on `http://127.0.0.1:8787` with a local database. Development builds accept that loopback origin; production builds only accept HTTPS.

## 2. Clerk

1. Create a Clerk application. Development uses its development instance; production needs a production instance on your own domain, which Clerk walks you through (DNS records for `clerk.<your-domain>`).
2. Set `CLERK_ISSUER` in the cloud Worker's `vars` to the Clerk Frontend API URL, for example `https://your-app.clerk.accounts.dev`, and copy the publishable key into `CLERK_PUBLISHABLE_KEY`. The Worker verifies Clerk's regular session tokens; no JWT template is needed.
3. Add a webhook in Clerk that sends `user.deleted` to `${VECTIS_CLOUD_URL}/clerk/webhook`, then store its signing secret:

```sh
pnpm --filter @vectis/cloud exec wrangler secret put CLERK_WEBHOOK_SECRET --env development
```

Without it, deleting an account inside Clerk would leave its machines and repository connections behind. Vectis verifies every delivery signature and ignores other events.

For production, also turn on bot sign-up protection. Anyone can create an account on a public deployment.

## 3. Site Worker

The Worker in `apps/web` serves the static site and forwards `/api/github/*` browser callbacks to the cloud Worker through a service binding (`CLOUD` in `apps/web/wrangler.jsonc`), so deploy the cloud Worker first. Then:

```sh
pnpm site:deploy:dev   # the "development" environment on workers.dev
pnpm site:deploy       # the "production" environment on its custom domain
```

The production route in `apps/web/wrangler.jsonc` is `vectis.kerd.dev`; change it to your own domain in a fork. To keep a development deployment private, follow [Private development environment](/docs/self-hosting/development-environment).

## 4. GitHub App

Vectis creates its GitHub App through GitHub's manifest flow, so the App's private key, client secret, and webhook secret are written straight into D1 and never touch your machine. The site Worker from step 3 must already serve `VECTIS_WEB_URL`, because GitHub returns to it. Create a one-time setup request in D1, then open the setup page:

```sh
set -a; . ./.env.local; set +a
state=$(openssl rand -hex 32)
digest=$(printf %s "$state" | shasum -a 256 | cut -d " " -f 1)
owner=your-github-login
owner_id=$(gh api "users/$owner" --jq .id)
expires=$(( ($(date +%s) + 3600) * 1000 ))
pnpm --filter @vectis/cloud exec wrangler d1 execute DB --env development --remote --command \
  "INSERT INTO githubAppSetups (stateDigest, ownerId, ownerLogin, organization, expiresAt, consumed) VALUES ('$digest', $owner_id, '$owner', 0, $expires, 0)"
open "$VECTIS_WEB_URL/api/github/app/setup?state=$state"
```

Use `organization` `1` when the owner is an organization. The setup link expires after an hour and works once. A deployment holds exactly one App.

For a development deployment, set `VECTIS_GITHUB_APP_NAME` to something like `Vectis [DEV]` and `VECTIS_GITHUB_APP_PUBLIC` to `false` before creating it, so only the owner account can install it.

After GitHub creates the App, open its settings to upload a logo and add privacy policy and support URLs. GitHub delivers webhooks directly to `${VECTIS_CLOUD_URL}/github/webhook`, which verifies every delivery signature.

## 5. Build clients

Clients connect to the deployment they were built for. With the variables in place:

```sh
pnpm package:cli --output /absolute/path/to/new-package --helpers /absolute/path/to/native-binaries --flavor production
```

A production package reads `VECTIS_CLOUD_URL` and `VECTIS_WEB_URL` from the environment or `.env.production.local` and bakes them in. Released apps ignore those variables at run time, so a stray `VECTIS_CLOUD_URL` in a user's shell cannot redirect them.

## Keeping deployments compatible

Released apps keep running against the cloud after you deploy a newer one. Add D1 migrations that the running Worker can live with, deploy changes that older clients can still use, and remove old behavior only after the releases that depend on it are gone.
