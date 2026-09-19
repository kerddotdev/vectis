---
title: Your account
description: What the connect page at vectis.kerd.dev shows and what you can do there.
---

[vectis.kerd.dev/connect](https://vectis.kerd.dev/connect) is your Vectis account. You sign in there to approve Macs and remote controllers, link GitHub and manage repository connections. It never runs jobs itself.

## Overview

A checklist from an empty account to a working setup: connect a Mac, link GitHub, install the App, connect a repository. Each step turns done when Vectis observes it.

## Macs

Every Mac connected to your account, whether it is online (seen in the last 90 seconds), paused or offline, and the environments it reports with their state. Macs connect from the app (**Connections > Connect in browser**) or with `vectis cloud pair`; you approve the request on this page after comparing the verification code.

## GitHub

The GitHub accounts you linked and the Vectis App installations each one can use. Linking proves which GitHub account is yours; it does not start jobs or change workflows. After installing the App or changing its repository access on GitHub, link the account again with **Link GitHub account** so Vectis sees the change.

## Repositories

All repository connections across your Macs, grouped by repository, with each connection's `runs-on` label. **Connect a repository** creates a connection on any of your Macs; **Disable connection** removes one. Automatic runners are turned on per connection in the app or the CLI.

## Remote access

The apps, CLIs and agents you allowed to control your Macs. Access lasts up to 90 days. **Revoke** ends it immediately; that client has to sign in again.

## Approvals

Pairing and sign-in requests open this page with a verification code. Approve only requests you started yourself and whose code matches, and never share the link. Requests expire after ten minutes.
