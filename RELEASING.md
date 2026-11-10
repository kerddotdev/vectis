# Releasing Vectis

This is the maintainer runbook for CI and releases. Contributors only need [CONTRIBUTING.md](CONTRIBUTING.md).

## How CI runs

Vectis runs its own CI on a maintainer's Mac. The metadata-only `pull_request_target` jobs `pr-title` and `pr-size` use GitHub-hosted runners because that event bypasses fork workflow approval. The Native helper check temporarily uses GitHub's `macos-26` ARM64 runner because the Vectis macOS image lacks Xcode:

| Label                   | Environment                                                                             | Used by                                               |
| ----------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `vectis-ubuntu`         | Ubuntu 24.04 environment with the ID `ubuntu`                                           | `check`, labels, backend and site deploys, publishing |
| `vectis-macos-26-arm64` | macOS 26 environment with the ID `macos-26-arm64`, with Xcode 26 installed in the guest | signed desktop release                                |

A runner label is always `vectis-` followed by the environment ID, so the CI Mac's environments have to carry exactly these IDs. Changing an ID means changing every `runs-on` in `.github/workflows` and the required checks in the `main` ruleset.

Each Mac runs as many automatic runners at once as its concurrency limit and CPU and memory allow, so workflows stay few and cancel superseded runs.

## Set up the CI Mac

1. Install a signed production build of Vectis and install its service.
2. Pair the Mac with the production account, link the `kerddotdev` GitHub account, and install the Vectis GitHub App on `kerddotdev/vectis`.
3. Prepare the `ubuntu` environment. Prepare the `macos-26-arm64` environment, and while its setup console is open, install Xcode 26 and accept its license in the guest before finishing setup.
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
| Variable | `VECTIS_CLOUD_URL`, `VECTIS_WEB_URL`   | The production deployment baked into the apps                       |

`production` (deployment branches and tags: `main`, `v*`):

| Kind     | Name                                        | Value                                                  |
| -------- | ------------------------------------------- | ------------------------------------------------------ |
| Secret   | `CLOUDFLARE_API_TOKEN`                      | Token that can deploy Workers and migrate D1 databases |
| Variable | `CLOUDFLARE_ACCOUNT_ID`                     | Cloudflare account ID                                  |
| Variable | `VECTIS_CLOUD_URL`, `CLERK_PUBLISHABLE_KEY` | Production values for the website build                |

## Cut a release

1. Open a pull request titled `chore(release): vX.Y.Z` that changes `version` in the root `package.json` and adds `.github/release-notes/vX.Y.Z.md` (see [Release notes](#release-notes)). Merge it.
2. Tag the merge commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`. A tag with a hyphen, such as `v0.2.0-rc.1`, becomes a prerelease.
3. Approve the `release` deployment. The workflow checks the tag against the version, runs `check`, applies D1 migrations and deploys the cloud Worker, builds, signs and notarizes the app in the macOS VM, publishes the GitHub release as `Vectis X.Y.Z` with the written notes followed by the generated pull request list, and redeploys the website so the changelog and download pick up the release.
4. Installed apps find the update within four hours.

Backend changes must keep working with the previous release, because installed apps update at their own pace.

## Release notes

Every release uses the same notes. The written part lives in `.github/release-notes/vX.Y.Z.md`; `preflight` refuses a tag without it, and `publish` appends GitHub's generated `## What's Changed` list (merged pull requests and the full changelog link). The website changelog shows the published notes, so fix a release afterwards by editing that file and the GitHub release together, then redeploying the site.

The file has exactly these parts, in this order:

```md
# Vectis X.Y.Z

**Two or three sentences in bold: what changed for the user.**

## Highlights

### A short topic phrased as an outcome

## Updating

## Compatibility

## Platform requirements and limitations
```

- **Highlights**: one `###` topic per change a user notices, as a short paragraph or bullets. Security fixes, other fixes and measurements are topics here too (`### Security`, `### Fixes`, `### Measured on a real Mac`), never separate sections. A patch release still has at least one topic.
- **Updating**: start with "Installed apps find this release within four hours, and the update waits for active work to finish." Then say what the user has to do after updating, such as preparing an environment again or pairing again, or "Nothing needs to be prepared again."
- **Compatibility**: which app versions the cloud still serves, what needs the new app, and what existing images miss. When nothing applies: "The app, CLI and service ship together."
- **Platform requirements and limitations**: one paragraph describing the platform as of this release.

State only verified behavior, in plain English with ASCII hyphens and no emojis. Use no other headings, and do not write the pull request list by hand. `.github/release-notes/v0.5.0.md` is a complete example.
