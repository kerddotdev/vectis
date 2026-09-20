# Third-party components

Vectis's original code is licensed under the MIT License in `LICENSE`. Third-party components retain their own licenses. This notice does not replace their license texts or source-distribution requirements.

- The QEMU compatibility patch in `native/qemu/patches` is GPL-2.0-or-later, matching the modified upstream source. See `native/qemu/README.md` for the source version and distribution requirements.
- Portable development packages include Node.js with its upstream `LICENSE` file and production JavaScript dependencies with their package license files.
- Desktop packages additionally contain Electron and its bundled Chromium and third-party notices.
- The Linux guest package list is taken from the `apt` section of the Ubuntu 24.04 ARM64 toolset in [actions/runner-images](https://github.com/actions/runner-images), MIT, so a prepared guest provides what a GitHub-hosted runner does at that layer. No code or image from that project is included or redistributed.
- Guest preparation downloads the GitHub Actions runner and, for Windows guests, MinGit from Git for Windows. Both are fetched from their publishers at preparation time against pinned checksums, and neither is included in or redistributed with Vectis.
- QEMU, TPM components, firmware, and guest operating systems are separate components. Do not distribute their binaries or images under Vectis's MIT License. Include their applicable license materials and corresponding source where required.

Guest operating system installers and images are not included in the source repository or portable development packages.
