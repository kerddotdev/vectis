---
title: Privacy Policy
description: What the Vectis website and hosted account service collect, why, where it goes, how long it is kept, and your rights.
summary: Vectis runs your CI on your own Mac. This policy explains the small amount of data the website and the hosted account service handle to connect that Mac to GitHub, and what you can ask us to do with it.
effective: September 19, 2026
---

## 1. Who we are

Vectis is built and operated by Dániel Kerekes, an individual based in Hungary ("we", "us", "our"). We are the data controller for the personal data described in this policy.

- Privacy questions and requests: [kerd@kerd.dev](mailto:kerd@kerd.dev)
- Security reports: [security@kerd.dev](mailto:security@kerd.dev) or GitHub private vulnerability reporting, as described in our [security policy](https://github.com/kerddotdev/vectis/security/policy)

We have not appointed a data protection officer because the law does not require one for a service of this kind. Write to the address above about anything in this policy.

## 2. What this policy covers

Vectis has three parts, and they handle data differently:

- **The software.** The Vectis app, the `vectis` command line tool, the MCP server and the background service run on your Mac. They are open source under the MIT License. On their own they send nothing to us.
- **The hosted account service.** The website at vectis.kerd.dev, the account page at vectis.kerd.dev/connect, the cloud backend and the Vectis GitHub App. You use it when you connect a Mac to an account, link GitHub, connect repositories or control a Mac remotely.
- **The website.** The public pages and the documentation at vectis.kerd.dev.

This policy covers the hosted account service and the website, plus the few network requests the software makes on its own. If you run your own deployment of Vectis, whoever operates it is responsible for it, and this policy does not apply to it.

## 3. Definitions

- **Personal data** means any information that relates to an identified or identifiable person, as defined in the General Data Protection Regulation (EU) 2016/679 ("GDPR").
- **Account** means your sign-in identity on the hosted account service.
- **Mac** or **machine** means a computer running the Vectis service that you connected to your account.
- **Controller** means an app or command line tool you authorized to control your Macs remotely.
- **Processor** means a company that processes personal data on our behalf and under our instructions.

## 4. What stays on your Mac

The core promise of Vectis is that your CI runs on your hardware. The following data is created and kept on your Mac and is not sent to us by the software:

- Virtual machine images, disks, and the files your jobs build and use.
- The local service database, its log file, and its local access token.
- Your machine and controller credentials, which are stored in the macOS Keychain on that Mac only.
- Anything your workflows do. Jobs talk to GitHub directly from the virtual machine. Logs, artifacts and caches that your workflows upload go to GitHub under GitHub's terms.

Two exceptions are covered below: status reports that a connected Mac sends to the account service (section 5.3), and read-only answers a Mac returns when you ask it for information remotely (section 5.5).

## 5. What the account service collects

### 5.1 Your sign-in account

Sign-in is provided by Clerk. When you create an account, Clerk collects your email address and, depending on the sign-in method you choose, your name, profile picture and the identifier of the provider you sign in with. Clerk also records technical information needed to keep sessions secure, such as your IP address, browser and device details, and sign-in times.

Our backend receives only an opaque account identifier from Clerk. It does not read or store your email address or name.

### 5.2 Linked GitHub accounts

When you link a GitHub account, you sign in to GitHub and approve the Vectis GitHub App. We store:

- your GitHub user ID and login;
- the GitHub App installations you can access, with the ID and login of each account or organization they belong to;
- the time the link was verified.

GitHub gives us a short-lived user token to read these details. We use it only during verification and do not store it.

### 5.3 Macs you connect

When you connect a Mac to your account, we store:

- the Mac's name, which defaults to its computer name (hostname), and a random local identifier;
- a one-way fingerprint (SHA-256 digest) of the Mac's credential, never the credential itself;
- when the Mac was connected and when it was last seen;
- whether it is paused or idle;
- a summary of each prepared environment: its ID, name, operating system, CPU count, memory size, state and a revision fingerprint.

A connected Mac keeps an outgoing connection to the account service and updates this status about every 30 seconds.

### 5.4 Repositories, jobs and runners

When you connect a repository, we store its GitHub ID, name and owner, the App installation, the Mac and environment it runs on, and whether automatic runners are on.

GitHub sends the Vectis GitHub App notifications (webhooks) about workflow jobs and repositories. For each workflow job we store its IDs, name, status, result, labels, and the ID and name of the runner that took it. For each notification we store its delivery ID, event type, time and related repository and installation IDs, so that it is processed only once. GitHub sends these notifications for every repository the App is installed on, so we may receive job records for repositories of an installation that you have not connected to a Mac.

To start a runner, we ask GitHub for a single-use runner registration for your repository and hand it to your Mac. We keep a record of each runner (its Mac, environment, GitHub runner ID and state).

### 5.5 Remote control and operations

When you approve a controller, we store its name and one-way fingerprints of its credentials.

When you send a command to a Mac through the account service, we store the command, its status and a short result message until your Mac picks it up and reports back. Commands can contain local file paths and, for a workflow migration preview, the content of workflow files you submit.

When you ask a Mac for information remotely (for example its status, storage, diagnostics or recent service log lines), the Mac's answer passes through the account service to you. These answers can contain local file paths, your home directory path, virtual machine details such as network hardware addresses, and service log lines.

### 5.6 Workflow migrations

When you ask Vectis to prepare a workflow migration for a connected repository, your Mac reads the workflow files from GitHub and we store the preview: the file paths, the original and proposed workflow contents, the base branch and commit, and any findings. If you choose to publish it, the Vectis GitHub App creates a branch, a commit and a pull request in your repository. It never merges it.

### 5.7 Messages you send us

If you email us, we receive your email address, the content of your message and anything you attach.

### 5.8 Website visits

The website does not use analytics or advertising. When you visit, Cloudflare, which hosts the site, processes your IP address and request details to deliver pages and protect the site against attacks. We do not use these details to identify you.

## 6. What the software sends on its own

Even when your Mac is not connected to an account, the software makes these requests to third parties. They are not sent to us:

- **Updates.** The packaged app checks GitHub Releases for new versions about every four hours and downloads them in the background. GitHub sees your IP address, the app version and standard request details.
- **Downloads you start.** Preparing an environment downloads the GitHub Actions runner from GitHub, Ubuntu cloud images from Canonical, and macOS restore images from Apple, as the documentation describes. Windows installation media come from you.

The software has no telemetry, analytics or crash reporting.

## 7. How and why we use your data

We use personal data only to run the service you asked for. The legal bases under Article 6(1) GDPR are:

| Purpose                                                                                                                                             | Legal basis                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Creating and securing your account, connecting Macs, linking GitHub, connecting repositories, starting runners, remote control, workflow migrations | Performance of our agreement with you (Art. 6(1)(b))                                        |
| Processing GitHub notifications once, keeping job records, preventing abuse, protecting the service and investigating security issues               | Our legitimate interest in operating a reliable and secure service (Art. 6(1)(f))           |
| Answering your messages and requests                                                                                                                | Performance of our agreement, or our legitimate interest in replying (Art. 6(1)(b) and (f)) |
| Keeping records the law requires and responding to lawful requests                                                                                  | Legal obligation (Art. 6(1)(c))                                                             |

Where we rely on legitimate interests, we have weighed them against your rights. You can object at any time (section 12).

We do not sell or rent personal data, show ads, build advertising profiles, or make decisions about you based solely on automated processing that have legal or similarly significant effects.

## 8. Cookies and browser storage

The website does not set cookies of its own. It stores two things in your browser:

- your light or dark theme choice, in local storage;
- on the account page, the pairing or controller request you are approving, in session storage. The request travels in the part of the link after `#`, which browsers do not send to servers, and the stored copy is removed when you close the tab.

On the account page, Clerk sets the cookies it needs to keep you signed in, and may use Cloudflare Turnstile to tell people from bots when you sign up. Cloudflare may set strictly necessary security cookies. All of these are needed for the service to work, so we do not ask for consent to them. You can block cookies in your browser, but then you cannot sign in.

## 9. Who we share data with

We use these providers to run the service. They process personal data on our behalf, under data processing terms, and only to provide their services to us:

| Provider                                                      | What it does                                            | Data it handles                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Clerk, Inc.](https://clerk.com/legal/privacy)                | Sign-in and session management                          | Account and session data (section 5.1)                                        |
| [Convex, Inc.](https://www.convex.dev/legal/privacy)          | Cloud backend and database                              | Everything in sections 5.2 to 5.6                                             |
| [Cloudflare, Inc.](https://www.cloudflare.com/privacypolicy/) | Website hosting, network delivery and attack protection | Request data of website and account page visits, and GitHub sign-in callbacks |

**GitHub** is not our processor. When you install the Vectis GitHub App or link your GitHub account, you share data between GitHub and us under [GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement). We send GitHub the requests needed to verify your access, register runners, read job states and, when you ask, open pull requests.

We may also disclose personal data if the law requires it, to protect the rights, safety or property of users or others, or to establish, exercise or defend legal claims. If the service is transferred to another operator, we will tell you in advance, and this policy will continue to protect your data.

## 10. International transfers

Our providers are based in the United States and may store and process data outside the European Economic Area. Where they do, the transfer is protected by an adequacy decision, such as the EU-U.S. Data Privacy Framework for providers certified under it, or by the European Commission's standard contractual clauses. You can ask us for more information about these safeguards.

## 11. How long we keep data

| Data                                                                                                                            | How long                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Answers to remote information requests                                                                                          | About one minute                                                                                                                                                   |
| Single-use runner registrations                                                                                                 | Deleted when the runner starts, finishes or fails, and at the latest after 15 minutes                                                                              |
| Pending pairing, controller and GitHub link requests                                                                            | 10 minutes, then no longer usable                                                                                                                                  |
| Workflow migration previews, including workflow contents                                                                        | 24 hours                                                                                                                                                           |
| Controller authorizations                                                                                                       | Valid for 90 days or until you revoke them; the revoked record is kept with your account                                                                           |
| Account, linked GitHub accounts, Macs, repository connections, runner records, operations, job records and notification records | While your account exists. Disconnected repositories and removed Macs and controllers stop being used immediately, and their records are deleted with your account |
| Sign-in data at Clerk                                                                                                           | While your account exists                                                                                                                                          |
| Emails                                                                                                                          | As long as needed to handle your request, and no longer than two years after it is resolved                                                                        |

To delete your account and everything linked to it, email [kerd@kerd.dev](mailto:kerd@kerd.dev) from the address you sign in with. We delete the data within 30 days, both from our backend and from Clerk. Uninstalling the Vectis GitHub App from your GitHub account or organization stops future notifications for it; to delete job records of repositories you never connected, ask us at the same address.

Our providers may keep backup copies for a limited time under their own retention schedules.

## 12. Your rights

Under the GDPR, you have the right to:

- **access** your personal data and receive a copy of it;
- **rectify** data that is inaccurate or incomplete;
- **erase** your data;
- **restrict** how we process it;
- receive your data in a portable, machine-readable format (**portability**);
- **object** to processing based on our legitimate interests.

To use these rights, email [kerd@kerd.dev](mailto:kerd@kerd.dev). We may ask you to confirm the request from your sign-in address so we can verify it is you. We answer within one month. If a request is complex, we may extend this by up to two more months and will tell you why. Using your rights is free unless a request is clearly unfounded or excessive.

You can change some of your data yourself: revoke controllers and disconnect repositories on the account page or in the app, and manage your email and sign-in methods in your account settings. To remove a Mac or unlink a GitHub account, email us.

You also have the right to lodge a complaint with a data protection authority, in particular where you live or work or where you think the law was broken. In Hungary this is the Nemzeti Adatvédelmi és Információszabadság Hatóság (NAIH), 1055 Budapest, Falk Miksa utca 9-11, [ugyfelszolgalat@naih.hu](mailto:ugyfelszolgalat@naih.hu), [naih.hu](https://naih.hu). You can also go to court. We would appreciate the chance to address your concern first.

## 13. How we protect data

- All connections to the website, the account service and GitHub use TLS.
- We store only one-way fingerprints of machine and controller credentials. Machines prove their identity with short-lived signed tokens that expire after five minutes.
- The local service accepts connections only from the same Mac and requires a local token. It never opens an inbound port to the internet.
- GitHub access tokens are requested for each task with the narrowest permissions that task needs, and are not stored.
- Runner registrations are single use and deleted after at most 15 minutes.
- Access to the production systems is limited to the operator.
- The code is public, so anyone can review how the service handles data.

No system is perfectly secure. If a breach affects your personal data and is likely to put your rights at risk, we will notify the supervisory authority and, where required, you, as the GDPR requires.

## 14. Children

The service is not directed at children. You must be at least 16 years old to create an account. If you believe a child has given us personal data, contact us and we will delete it.

## 15. Residents of the United States

We do not sell personal information or share it for cross-context behavioral advertising, and we do not use sensitive personal information to infer characteristics about you. Wherever you live, you can use the rights in section 12, and we will not treat you differently for doing so.

## 16. Changes to this policy

We will post any change to this policy on this page and update the effective date. If a change materially affects how we use personal data you have already given us, we will tell you on this site and, where we can, by email before it takes effect. Earlier versions are available in the [project's history](https://github.com/kerddotdev/vectis/commits/main/apps/web/src/legal/privacy.md).

## 17. Contact

Dániel Kerekes, Hungary. [kerd@kerd.dev](mailto:kerd@kerd.dev)
