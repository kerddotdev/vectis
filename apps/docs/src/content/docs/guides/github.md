---
title: Connect GitHub accounts
description: Verify a GitHub account and review its App installations.
---

Open [GitHub connections](https://vectis.kerd.dev/connect?github=1) and sign in to Vectis. Choose **Connect a GitHub account**, select the intended account on GitHub, and authorize the Vectis development App. When you return, review the verified login and confirm the connection.

You can repeat this for another GitHub account. The Vectis sign-in account owns the connections; signing in through Clerk does not automatically prove ownership of every GitHub account.

Requests expire after ten minutes. If authorization fails or the request was already used, dismiss it and start again. Do not approve authorization links sent by someone else. A GitHub identity already linked to a different Vectis account cannot be silently transferred.

The page shows active App installations accessible during verification. This is a snapshot, not a grant to run jobs. Repository access and runner readiness still require separate checks. Suspended installations and installations belonging to another App are excluded.

The current connection flow does not provision runners, change workflows, or create migration PRs. User access tokens are used only in the backend during verification and are not saved or returned to clients. Reconnecting refreshes the installation snapshot.
