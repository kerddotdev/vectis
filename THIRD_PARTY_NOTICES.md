# Third-party components

Vectis's original code is licensed under the MIT License in `LICENSE`. Third-party components retain their own licenses. This notice does not replace their license texts or source-distribution requirements.

- The QEMU compatibility patch in `native/qemu/patches` is GPL-2.0-or-later, matching the modified upstream source. See `native/qemu/README.md` for the source version and distribution requirements.
- Portable development packages include Node.js with its upstream `LICENSE` file and production JavaScript dependencies with their package license files.
- Desktop packages additionally contain Electron and its bundled Chromium and third-party notices.
- The Linux guest package list is taken from the `apt` section of the Ubuntu 24.04 ARM64 toolset in [actions/runner-images](https://github.com/actions/runner-images), MIT, so a prepared guest provides what a GitHub-hosted runner does at that layer. No code or image from that project is included or redistributed.
- Guest preparation downloads the GitHub Actions runner and, for Windows guests, MinGit from Git for Windows. Both are fetched from their publishers at preparation time against pinned checksums, and neither is included in or redistributed with Vectis.
- QEMU, TPM components, firmware, and guest operating systems are separate components. Do not distribute their binaries or images under Vectis's MIT License. Include their applicable license materials and corresponding source where required.

Guest operating system installers and images are not included in the source repository or portable development packages.

## shadcn state variants

The desktop state variants in `apps/desktop/src/renderer/style.css` are copied from
`shadcn@4.23.0`, `dist/tailwind.css` (custom variants section), without behavioral changes.
Upstream: [shadcn-ui/ui](https://github.com/shadcn-ui/ui).
Published source: [shadcn 4.23.0 tarball](https://registry.npmjs.org/shadcn/-/shadcn-4.23.0.tgz).
Only these CSS variants are needed at build time; the component generator CLI is not
a build or runtime dependency. `apps/desktop/components.json` remains available for
optional component generation with an explicitly invoked CLI.

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
