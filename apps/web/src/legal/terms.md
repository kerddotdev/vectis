---
title: Terms of Service
description: The terms for using the hosted Vectis account service, the website, and the official Vectis downloads.
summary: These terms apply to the hosted Vectis account service and the website. The Vectis software itself is open source under the MIT License, which these terms do not change.
effective: September 19, 2026
---

## 1. About these terms

These Terms of Service ("Terms") are an agreement between you and Dániel Kerekes, an individual based in Hungary ("we", "us", "our"), who builds and operates Vectis.

By creating an account, connecting a Mac, installing the Vectis GitHub App or otherwise using the Service, you agree to these Terms. If you use the Service for an organization, you confirm that you are allowed to accept these Terms for it, and "you" includes that organization. If you do not agree, do not use the Service.

Our [Privacy Policy](/privacy) explains how we handle personal data and is part of these Terms.

## 2. Definitions

- **Service** means the hosted account service at vectis.kerd.dev, including the account page at vectis.kerd.dev/connect, the cloud backend, the Vectis GitHub App, and the website and documentation.
- **Software** means the Vectis desktop app, the `vectis` command line tool, the MCP server, the background service and all other code in the [Vectis repository](https://github.com/kerddotdev/vectis), including the official builds we publish.
- **Mac** means a computer on which you run the Software.
- **Environment** means a guest operating system image you prepare with the Software. An **instance** is a temporary virtual machine started from it.
- **Your Content** means the repositories, workflows, code, commands and other material you connect to or process with the Service or the Software.

## 3. The Software and the Service

The Software is open source under the [MIT License](https://github.com/kerddotdev/vectis/blob/main/LICENSE). Your use of the code, including copying, modifying and redistributing it, is governed by that license and not by these Terms. Components included with the Software keep their own licenses, listed in the [third-party notices](https://github.com/kerddotdev/vectis/blob/main/THIRD_PARTY_NOTICES.md).

The Service is an optional, hosted part of Vectis. It lets you connect your Macs to an account, link GitHub, connect repositories, start runners automatically for queued jobs, and control your Macs remotely. You can use the Software without the Service, and you can run your own deployment of the Service from the same code. These Terms cover only our deployment.

## 4. Early software

Vectis is new, and its version numbers start at 0. Features may change, and the Software and the Service may contain bugs that interrupt jobs, leave virtual machines or disks behind, or require you to prepare environments again. Keep your own backups, and do not rely on Vectis as the only way to build, test or release software that matters to you.

## 5. Price

The Service is currently free. If we introduce paid features, we will announce them in advance, and nothing you have used for free will be charged for retroactively.

## 6. Eligibility and your account

You must be at least 16 years old and able to enter into a binding agreement to use the Service.

When you create an account:

- give accurate information, and keep your sign-in method and email address secure;
- approve a Mac pairing, a remote control request or a GitHub link only when you started it yourself and the verification code matches. Anyone you approve can act on your account within the limits of what you approved;
- tell us promptly at [security@kerd.dev](mailto:security@kerd.dev) if you think someone else has access to your account, a Mac credential or a controller.

You are responsible for activity carried out through your account, your connected Macs and the controllers you approve.

## 7. Your Mac and the code it runs

Vectis runs GitHub Actions jobs in virtual machines on your own hardware. That means:

- **You choose what runs.** Jobs run the code in the workflows of the repositories you connect, including code from pull requests. You are responsible for which repositories you connect, which workflows reach your Mac, and the approval settings of your repositories on GitHub. The Service requires public repositories to make outside contributors wait for approval, but approving a run remains your decision.
- **Isolation has limits.** The Software is designed to keep jobs away from your Mac's files and credentials, but no virtualization is perfect. Do not run workflows you do not trust, and keep your Mac and the Software up to date.
- **You provide the resources.** Jobs use your Mac's processor, memory, storage, network and electricity. You are responsible for any costs, and for keeping enough free space for the environments you prepare.
- **Instances are temporary.** The Software deletes each instance when its job ends. Anything a job leaves only inside its instance is lost unless the job uploads it elsewhere.
- **Secrets are yours to protect.** Workflows may receive secrets from GitHub. Configure them so that only the jobs that need them can use them.

## 8. Guest operating system licenses

The Software helps you prepare Ubuntu, macOS and Windows environments, but it does not license any operating system to you. You are responsible for complying with the license terms of every operating system you run, including:

- Apple's software license agreement for macOS, which limits where and how many macOS virtual machines you may run;
- Microsoft's license terms for Windows, including having a valid license for each installation. Windows support is experimental, and you provide the installation media, drivers and firmware yourself;
- Canonical's terms for Ubuntu images.

## 9. GitHub

To connect repositories, you install the Vectis GitHub App on your GitHub account or organization and link your GitHub account to the Service. Your use of GitHub, including GitHub Actions, is governed by your agreement with GitHub, and you must comply with it.

When you install the App, you allow the Service to use the permissions shown during installation for the repositories you choose. The Service uses them to:

- verify that you are allowed to connect a repository;
- register single-use runners for your jobs and read the state of your jobs;
- read workflow files when you ask for a migration preview;
- create a branch, commit and pull request when you choose to publish a migration. The Service never merges pull requests.

For organization repositories, your linked GitHub account needs administrator permission on the repository, and the Service checks this each time it acts. You can uninstall the App from GitHub at any time. Doing so stops the Service from acting on those repositories.

## 10. Acceptable use

You must not use the Service or the official builds to:

- break the law, or infringe or misappropriate anyone's rights;
- run jobs for repositories, accounts or organizations you are not authorized to use;
- get around GitHub's rules, limits or approval requirements, or anyone's security measures;
- access or try to access another user's account, Macs, repositories or data;
- probe, scan or test the Service in a way that harms it or other users, except for good-faith security research under section 11;
- overload the Service, send it automated traffic beyond normal use of the Software, or create accounts in bulk or by automated means;
- distribute malware or use the Service to attack other systems;
- resell or provide the Service to others as a hosted offering. You may run your own deployment of the code under the MIT License.

## 11. Security research

We welcome good-faith security research. If you follow our [security policy](https://github.com/kerddotdev/vectis/security/policy), report vulnerabilities privately, only test against accounts and machines you own, avoid harming other users and their data, and give us reasonable time to fix an issue before disclosing it, we will not pursue legal action against you for that research.

## 12. Your Content

You keep all rights to Your Content. You give us a limited, non-exclusive, worldwide, royalty-free permission to store, process and transmit Your Content only as needed to provide the Service to you, for example to pass a command to your Mac or to show you a migration preview. This permission ends when the content is deleted from the Service, as described in the Privacy Policy.

You confirm that you have the rights needed to connect Your Content to the Service.

## 13. Names and feedback

The MIT License covers the code, not the Vectis name and logo. You may use the name to refer to Vectis truthfully, but not in a way that suggests that your product, fork or deployment is ours or is endorsed by us.

If you send us ideas, suggestions or other feedback, we may use them without any obligation to you.

## 14. Updates

The official desktop app checks GitHub Releases for new versions and downloads them in the background. It installs an update only after you choose to, and waits until no virtual machines or operations are running. We may stop supporting old versions when the Service changes. We try to keep the Service compatible with recent releases, but older versions may stop working with it.

## 15. Third-party services

The Service relies on GitHub, Clerk, Convex, Cloudflare and other providers, and the Software downloads files from GitHub, Canonical and Apple. We are not responsible for services we do not control, and their own terms apply to your use of them.

## 16. Availability and changes

We do not guarantee that the Service will be available at any particular time, or at all. We may change, suspend or stop the Service or any part of it. If we plan to shut the Service down, we will announce it on this site at least 30 days in advance where we reasonably can. Because the code is open source, you can keep running the Software and deploy the Service yourself.

## 17. Suspension and termination

You can stop using the Service at any time. To delete your account and its data, follow the [Privacy Policy](/privacy#11-how-long-we-keep-data).

We may suspend or end your access to the Service, or disconnect a Mac or a repository, if you seriously or repeatedly breach these Terms, if your use puts the Service, other users or third parties at risk, or if the law requires it. Where it is reasonable and lawful, we will tell you first and give you a chance to fix the problem.

When your access ends, your right to use the Service ends, and the Software stops receiving commands and runner registrations from it. The MIT License continues to apply to the Software. Sections that by their nature should continue, such as 12, 13 and 18 to 22, continue after termination.

## 18. Disclaimers

The Service and the official builds are provided "as is" and "as available", free of charge. To the extent the law allows, we make no warranties of any kind, express or implied, including warranties of merchantability, fitness for a particular purpose, non-infringement, accuracy or uninterrupted operation. We do not warrant that jobs will run, succeed or finish, that environments will prepare successfully, or that isolation will prevent every harm.

If you are a consumer, you keep the rights that the law of your country gives you and that cannot be waived by agreement. Nothing in these Terms limits them.

## 19. Limitation of liability

To the extent the law allows, we are not liable for:

- indirect, incidental, special or consequential damages;
- loss of profits, revenue, business, goodwill or data;
- damage caused by the code your jobs run, by the repositories and workflows you connect, or by people you approve on your account;
- problems caused by GitHub or other third-party services, your hardware, your network or your operating systems.

To the extent the law allows, our total liability for all claims relating to the Service or the official builds is limited to 50 euros.

Nothing in these Terms limits or excludes liability for damage caused intentionally or by gross negligence, for harm to life, body or health, or any other liability that cannot be limited or excluded under applicable law, including Section 6:152 of the Hungarian Civil Code.

## 20. Indemnity

If you use the Service for a business or organization, you will compensate us for reasonable losses and costs, including reasonable legal fees, that arise from third-party claims about Your Content or your breach of these Terms. This section does not apply to you as a consumer.

## 21. Changes to these Terms

We may update these Terms to reflect changes to the Service or the law. We will post the new version on this page and update the effective date. For material changes, we will give at least 30 days' notice on this site and, where we can, by email. If you continue to use the Service after a change takes effect, the new Terms apply. If you do not agree, stop using the Service and ask us to delete your account. Earlier versions are available in the [project's history](https://github.com/kerddotdev/vectis/commits/main/apps/web/src/legal/terms.md).

## 22. Governing law and disputes

These Terms are governed by the laws of Hungary, without regard to conflict of law rules. If you are a consumer living in the European Union, you also keep the protection of the mandatory rules of the country where you live.

We would like to resolve any concern with you directly first, so please write to us. Disputes are decided by the competent courts of Hungary. If you are a consumer, you may also bring proceedings in the courts of the country where you live.

## 23. General

- These Terms and the Privacy Policy are the entire agreement between you and us about the Service.
- If a court finds part of these Terms unenforceable, the rest remains in effect.
- If we do not enforce a right, we have not waived it.
- You may not transfer your rights under these Terms without our consent. We may transfer them to whoever takes over the Service, and we will tell you if that happens.
- These Terms are written in English. Translations, if any, are for convenience only.

## 24. Contact

Dániel Kerekes, Hungary

- General questions: [kerd@kerd.dev](mailto:kerd@kerd.dev)
- Security reports: [security@kerd.dev](mailto:security@kerd.dev)
