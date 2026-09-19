# Releasing Vectis

This is the maintainer runbook for CI and releases. Contributors only need [CONTRIBUTING.md](CONTRIBUTING.md).

## How CI runs

Vectis runs its own CI. Every workflow targets a Vectis runner on a maintainer's Mac, never a GitHub-hosted runner:

| Label           | Environment                                                                    | Used by                                                                      |
| --------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `vectis-ubuntu` | Ubuntu 24.04 environment with the ID `ubuntu`                                  | `check`, `pr-title`, `pr-size`, labels, backend and site deploys, publishing |
| `vectis-macos`  | macOS 26 environment with the ID `macos`, with Xcode 26 installed in the guest | native helper builds and the signed desktop release                          |

The scheduler starts one automatic runner at a time per Mac, so workflows are few and cancel superseded runs.

## Set up the CI Mac

1. Install a signed production build of Vectis and install its service.
2. Pair the Mac with the production account, link the `kerddotdev` GitHub account, and install the Vectis GitHub App on `kerddotdev/vectis`.
3. Prepare the `ubuntu` environment. Prepare the `macos` environment, and while its setup console is open, install Xcode 26 and accept its license in the guest before finishing setup.
4. Connect `kerddotdev/vectis` to both environments and turn on automatic runners for both connections.
5. Push a pull request and confirm `check` runs in the Ubuntu VM.

## Repository settings

Rulesets need a public repository on the free plan. After the repository is public:

1. Import `.github/rulesets/main.json` and `.github/rulesets/release-tags.json` in **Settings > Rules > Rulesets**. Required checks: `check` and `pr-title`. Nobody bypasses the `main` rules; only admins create release tags.
2. In **Settings > Actions > General**, require approval for fork pull request workflows from all external contributors, and keep the default workflow token read-only.
3. In **Settings > Code security**, enable private vulnerability reporting, secret scanning with push protection, and Dependabot alerts.
4. Merges are squash-only with the pull request title as the commit message.

## GitHub environments

`release` (deployment tags `v*`, required reviewer: a maintainer):

| Kind     | Name                                   | Value                                                               |
| -------- | -------------------------------------- | ------------------------------------------------------------------- |
| Secret   | `MACOS_CERTIFICATE_P12`                | Base64 of the Developer ID Application certificate and key (`.p12`) |
| Secret   | `MACOS_CERTIFICATE_PASSWORD`           | Password of that `.p12`                                             |
| Secret   | `APPLE_API_KEY_P8`                     | Contents of the App Store Connect API key (`.p8`)                   |
| Variable | `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | The API key ID and issuer ID                                        |
| Variable | `MACOS_SIGNING_IDENTITY`               | For example `Developer ID Application: Name (TEAMID)`               |
| Variable | `CONVEX_URL`, `VECTIS_WEB_URL`         | The production deployment baked into the apps                       |

`production` (deployment branches and tags: `main`, `v*`):

| Kind     | Name                                                     | Value                                           |
| -------- | -------------------------------------------------------- | ----------------------------------------------- |
| Secret   | `CONVEX_DEPLOY_KEY`                                      | Production deploy key from the Convex dashboard |
| Secret   | `CLOUDFLARE_API_TOKEN`                                   | Token that can deploy Workers on the account    |
| Variable | `CLOUDFLARE_ACCOUNT_ID`                                  | Cloudflare account ID                           |
| Variable | `CONVEX_URL`, `CONVEX_SITE_URL`, `CLERK_PUBLISHABLE_KEY` | Production values for the website build         |

## Cut a release

1. Open a pull request titled `chore(release): vX.Y.Z` that only changes `version` in the root `package.json`. Merge it.
2. Tag the merge commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`. A tag with a hyphen, such as `v0.2.0-rc.1`, becomes a prerelease.
3. Approve the `release` deployment. The workflow checks the tag against the version, runs `check`, deploys the Convex backend, builds, signs and notarizes the app in the macOS VM, publishes the GitHub release with generated notes, and redeploys the website so the changelog and download pick up the release.
4. Installed apps find the update within four hours.

Backend changes must keep working with the previous release, because installed apps update at their own pace.
