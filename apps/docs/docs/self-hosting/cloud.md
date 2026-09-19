---
title: Run your own cloud
description: Deploy the Convex backend, Clerk sign-in, website, and GitHub App behind your own Vectis builds.
---

The hosted service at `vectis.kerd.dev` is one deployment of the code in this repository. You can run the same stack yourself, for a fork or for private development. A deployment has four parts:

| Part              | What it does                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Convex            | Accounts, machines, repository connections, GitHub webhooks, runner leases, and remote commands |
| Clerk             | Sign-in for the connect page                                                                    |
| Cloudflare Worker | Serves the website, the docs, and `/connect`, and forwards GitHub browser callbacks to Convex   |
| GitHub App        | Repository access and just-in-time runner registration                                          |

Vectis builds come in two flavors. **Development** builds (every source checkout) read `.env.local`, use `~/.vectis-dev`, and are named Vectis Dev. **Production** builds are packaged with `--flavor production`, read `.env.production.local` at package time, and use `~/.vectis`. Keep one set of Convex, Clerk, Worker, and GitHub App per flavor; never point a development build at production data.

[`.env.example`](https://github.com/kerddotdev/vectis/blob/main/.env.example) lists every variable. Copy it to `.env.local` or `.env.production.local` and fill it in as you go. Commands below use development; add `--prod` to Convex commands and use `.env.production.local` for production.

## 1. Convex

Create a Convex project and a development deployment. This writes `CONVEX_DEPLOYMENT`, `CONVEX_URL`, and `CONVEX_SITE_URL` to `.env.local`:

```sh
pnpm exec convex dev --once
```

For production, deploy with `pnpm exec convex deploy` and copy the production URLs into `.env.production.local`.

Create the key that signs short-lived machine tokens, store it on the deployment, and delete the local copy. Load the file first so the commands can use its values:

```sh
set -a; . ./.env.local; set +a
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out machine.pem
pnpm exec convex env set VECTIS_MACHINE_PRIVATE_KEY -- "$(cat machine.pem)"
rm machine.pem
pnpm exec convex env set VECTIS_MACHINE_ISSUER "$CONVEX_SITE_URL"
pnpm exec convex env set VECTIS_WEB_URL "$VECTIS_WEB_URL"
pnpm exec convex env set VECTIS_GITHUB_APP_NAME "Vectis"
```

`VECTIS_WEB_URL` is the HTTPS origin of your Worker (step 3), without a trailing slash.

## 2. Clerk

1. Create a Clerk application. Development uses its development instance; production needs a production instance on your own domain, which Clerk walks you through (DNS records for `clerk.<your-domain>`).
2. In **Integrations**, activate **Convex**. This creates the `convex` JWT template that Convex verifies.
3. Copy the publishable key into `CLERK_PUBLISHABLE_KEY`, and set the issuer on Convex:

```sh
pnpm exec convex env set CLERK_JWT_ISSUER_DOMAIN https://your-app.clerk.accounts.dev
```

For production, also turn on bot sign-up protection. Anyone can create an account on a public deployment.

## 3. Cloudflare Worker

The Worker in `apps/web` serves the static site and forwards `/api/github/*` browser callbacks to `CONVEX_SITE_URL`. Sign in with `pnpm --filter @vectis/web exec wrangler login`, then deploy:

```sh
pnpm site:deploy:dev   # the "development" environment on workers.dev
pnpm site:deploy       # the "production" environment on its custom domain
```

The production route in `apps/web/wrangler.jsonc` is `vectis.kerd.dev`; change it to your own domain in a fork. The deploy script passes `CONVEX_SITE_URL` to the Worker, so the configuration file holds no deployment URLs. To keep a development deployment private, follow [Private development environment](/docs/self-hosting/development-environment).

## 4. GitHub App

Vectis creates its GitHub App through GitHub's manifest flow, so the App's private key, client secret, and webhook secret are written straight into Convex and never touch your machine.

```sh
state=$(openssl rand -hex 32)
digest=$(printf %s "$state" | shasum -a 256 | cut -d " " -f 1)
owner=your-github-login
pnpm exec convex run githubAppSetup:create \
  "{\"stateDigest\":\"$digest\",\"ownerId\":$(gh api "users/$owner" --jq .id),\"ownerLogin\":\"$owner\",\"organization\":false}"
open "$VECTIS_WEB_URL/api/github/app/setup?state=$state"
```

Set `"organization": true` when the owner is an organization. The setup link expires after an hour and works once. A deployment holds exactly one App.

For a development deployment, set `VECTIS_GITHUB_APP_NAME` to something like `Vectis [DEV]` and `VECTIS_GITHUB_APP_PUBLIC` to `false` before creating it, so only the owner account can install it.

After GitHub creates the App, open its settings to upload a logo and add privacy policy and support URLs. GitHub delivers webhooks directly to `CONVEX_SITE_URL`, which verifies every delivery signature.

## 5. Build clients

Clients connect to the deployment they were built for. With the variables in place:

```sh
pnpm package:cli --output /absolute/path/to/new-package --helpers /absolute/path/to/native-binaries --flavor production
```

A production package reads `CONVEX_URL` and `VECTIS_WEB_URL` from the environment or `.env.production.local` and bakes them in. Released apps ignore those variables at run time, so a stray `CONVEX_URL` in a user's shell cannot redirect them.

## Keeping deployments compatible

Released apps keep running against the backend after you deploy a newer one. Deploy Convex changes that older clients can still use, and remove old behavior only after the releases that depend on it are gone.
