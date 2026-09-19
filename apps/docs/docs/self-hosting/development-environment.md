---
title: Private development environment
description: Run a development copy of the website, connect page, and backend that only you can reach.
---

A development environment lets you test pairing, GitHub linking, and remote control against your own backend without touching production. It uses the same parts as [your own cloud](/docs/self-hosting/cloud), with three extra locks so nobody else can use it.

## Layout

| Part                   | Development                                                            |
| ---------------------- | ---------------------------------------------------------------------- |
| Website and `/connect` | The `development` Worker on `vectis-dev.<account>.workers.dev`         |
| Backend                | Your Convex development deployment                                     |
| Sign-in                | Your Clerk development instance                                        |
| GitHub App             | A private App named like `Vectis [DEV]`                                |
| Local builds           | Every source checkout: `pnpm vectis`, `pnpm mcp`, `pnpm desktop:start` |

Source checkouts read `CONVEX_URL` and `VECTIS_WEB_URL` from `.env.local`, so once the file is filled in, pairing and login links point at the development environment automatically.

## Set it up

1. Follow [Run your own cloud](/docs/self-hosting/cloud) with development values. Set `VECTIS_WEB_URL` to `https://vectis-dev.<account>.workers.dev`.
2. Deploy the website with `pnpm site:deploy:dev`.
3. **Lock the website.** In the Cloudflare dashboard, open **Workers & Pages**, select `vectis-dev`, go to **Settings > Domains & Routes**, and choose **Enable Cloudflare Access** for `workers.dev`. Edit the `vectis-dev - Production` policy in Zero Trust so it allows only your email address. GitHub webhooks go straight to Convex, so nothing needs a bypass.
4. **Lock sign-in.** In the Clerk development instance, open **Configure > Restrictions**, turn on the allowlist with only your email address, and set sign-up mode to restricted. Nobody else can create an account, so nobody else can approve a pairing or control a machine.
5. **Lock the GitHub App.** Create it with `VECTIS_GITHUB_APP_PUBLIC=false`, so it can only be installed on the account that owns it.

## Check the locks

- In a private browser window, `https://vectis-dev.<account>.workers.dev/connect` shows the Cloudflare Access login instead of the page.
- Signing in to Clerk with another email address is refused.
- The App's public page on GitHub offers installation only to its owner.

## Use it

```sh
export VECTIS_HOME="$(mktemp -d)"
pnpm build
pnpm vectis service start
pnpm vectis cloud pair
```

The pairing link opens your development `/connect` page. Pass `--home` or `VECTIS_HOME` to keep test machines separate from `~/.vectis-dev`.
