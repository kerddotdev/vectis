---
title: Private development environment
description: Run a development copy of the website, connect page, and backend that only you can reach.
---

A development environment lets you test pairing, GitHub linking, and remote control against your own backend without touching production. It uses the same parts as [your own cloud](/docs/self-hosting/cloud), with three extra locks so nobody else can use it.

## Layout

| Part                   | Development                                                             |
| ---------------------- | ----------------------------------------------------------------------- |
| Website and `/connect` | The `development` Worker on its own hostname, such as `dev.example.com` |
| Backend                | The `development` cloud Worker and its D1 database                      |
| Sign-in                | Your Clerk development instance                                         |
| GitHub App             | A private App named like `Vectis [DEV]`                                 |
| Local builds           | Every source checkout: `pnpm vectis`, `pnpm mcp`, `pnpm desktop:start`  |

Source checkouts read `VECTIS_CLOUD_URL` and `VECTIS_WEB_URL` from `.env.local`, so once the file is filled in, pairing and login links point at the development environment automatically.

## Set it up

1. Follow [Run your own cloud](/docs/self-hosting/cloud) with development values. The `development` environments in `apps/web/wrangler.jsonc` and `apps/cloud/wrangler.jsonc` route `dev.vectis.kerd.dev` and `cloud-dev.vectis.kerd.dev`; change them to hostnames on your own domain and set `VECTIS_WEB_URL` and `VECTIS_CLOUD_URL` to match.
2. Deploy the cloud Worker, then the website with `pnpm site:deploy:dev`.
3. **Lock the website.** Before the first deploy, add a self-hosted application for the website hostname in Cloudflare Zero Trust under **Access > Applications**, with a policy that allows only your email address. Deploying first would leave the page open until the application exists. GitHub webhooks go straight to the cloud Worker, so nothing needs a bypass.
4. **Lock sign-in.** In the Clerk development instance, open **Configure > Restrictions**, turn on the allowlist with your email addresses, and enforce it on sign-in as well as sign-up. Nobody else can create an account or sign in, so nobody else can approve a pairing or control a machine.
5. **Lock the GitHub App.** Create it with `VECTIS_GITHUB_APP_PUBLIC=false`, so it can only be installed on the account that owns it.

## Check the locks

- In a private browser window, the website's `/connect` shows the Cloudflare Access login instead of the page.
- Signing in or signing up with another email address is refused.
- The App's public page on GitHub offers installation only to its owner.

## Use it

```sh
export VECTIS_HOME="$(mktemp -d)"
pnpm build
pnpm vectis service start
pnpm vectis cloud pair
```

The pairing link opens your development `/connect` page. Pass `--home` or `VECTIS_HOME` to keep test machines separate from `~/.vectis-dev`.
