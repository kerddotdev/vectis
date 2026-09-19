# Security policy

Vectis runs untrusted CI code in virtual machines on your own Mac and connects that Mac to a hosted cloud service. We take reports about both seriously.

## Reporting a vulnerability

Report vulnerabilities privately. Do not open a public issue, discussion, or pull request.

- Preferred: [open a private security advisory](https://github.com/kerddotdev/vectis/security/advisories/new) on GitHub.
- Alternative: email [security@kerd.dev](mailto:security@kerd.dev).

Include the affected version (`vectis --version`), your macOS version, the guest operating system if relevant, reproduction steps, and the impact you observed. We acknowledge reports as soon as we can, keep you updated while we investigate, and credit you in the advisory unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes. The desktop app updates itself; the CLI and MCP server update with it.

## Scope

In scope:

- Guest-to-host escapes, or guests reaching host files, sockets, or credentials they were not given
- Bypassing the local service's loopback, token, or origin checks
- Cloud authorization flaws: controlling another user's machine, repository, or runner capacity
- Fork or external pull request jobs gaining upstream runner capacity without maintainer approval
- Leaks of GitHub App credentials, runner registration tokens, or machine credentials

Out of scope:

- Code that you intentionally run in your own guest VMs
- Attacks that require an already compromised host account
- Denial of service against the hosted service through volume alone

Only test against machines, accounts, and repositories you own.
