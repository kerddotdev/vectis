---
title: Migrate repository workflows
description: Inspect workflow changes and create an idempotent migration pull request.
---

Connect a private personal repository to a prepared ARM64 environment first. Repository migration currently uses the paired machine's verified GitHub account and App installation. Organization and public repository policies are not enabled yet.

```sh
vectis repository list --json
vectis migration analyze <binding-id> --wait --json
```

Analysis reads workflow files from the default branch at a pinned commit. Its operation result contains a `previewId`, the original and proposed YAML, per-job findings, and whether the environment has successful runner evidence. The cloud retains the preview for 24 hours. The desktop offers **Connections > Analyze workflow migration** and displays the result in Overview. MCP accepts the same `migration.analyze` command.

Review the proposed changes before creating the PR:

```sh
vectis migration publish <preview-id> --wait --json
```

Publication requires an observed successful GitHub job and completed runner cleanup on the same binding and environment revision. Image metadata or configuration changes invalidate earlier evidence and previews. This revision check detects changes to the prepared image; it is not a substitute for source image checksum verification. Complete another test job after replacing an image, then analyze again.

The publisher checks the repository ID, current default branch and pinned base commit. It writes only changed workflow files on `vectis/migrate-workflows`, preserving the rest of the tree. It opens a regular PR and never merges it. The App needs Contents, Workflows and Pull requests write permissions for publication; analysis uses a separate read-only token.

Repeated requests return the existing PR, including a closed one, instead of recreating rejected changes. An interrupted request can be retried with the same preview after inspecting the branch and PR. A conflicting migration branch is left untouched. A moved default branch requires a fresh analysis.

The current automatic mappings cover Ubuntu 24.04 ARM64, Windows 11 ARM64, and macOS 26/latest labels for their corresponding environments. Static scalar selections and simple static matrices are supported. Dynamic expressions, expanded matrices, reusable workflows, aliased events and privileged event patterns require manual review. x64 labels never imply ARM64 compatibility. Check toolchain versions and action compatibility in the PR even when the runner architecture matches.

Review findings can coexist with safe changes: unsupported jobs keep their original runners. An empty migration cannot be published. To withdraw a proposal, close its PR without merging. After merging, revert the migration commit through normal GitHub review to restore the previous workflow. Automated PR closure and revert creation are not exposed by Vectis yet.
