# Third-party notices

fx-ui is licensed under the Apache License 2.0, in [LICENSE](LICENSE). The
repository also carries one binary built from other people's code, and one
patch to a dependency.

## vendor/gpuix-native.darwin-arm64.node

A build of [`@gpuix/native`](https://github.com/remorses/gpuix) 0.7.0, licensed
under the Apache License 2.0, modified by
[`patches/gpuix-native.diff`](patches/gpuix-native.diff). The patch changes the
text field's caret height and its handling of ⌘V, and adds `promptForPaths` to
the renderer.

The binary contains:

| Component | License | Copyright |
| --- | --- | --- |
| [GPUI](https://github.com/zed-industries/zed) (`gpui`, `gpui_platform`, `gpui_macos`) | Apache-2.0 | Copyright 2022 - 2025 Zed Industries, Inc. |
| Code GPUIX ports from [Comet](https://github.com/zeronsh/comet) | MIT | Copyright (c) 2026 Wing |
| [Syntect](https://github.com/trishume/syntect) 5.3.0 | MIT | Copyright (c) 2017 Tristan Hume, Keith Hall, Google Inc and other contributors |
| [fancy-regex](https://github.com/fancy-regex/fancy-regex) 0.16.2 | MIT | Copyright 2015 The Fancy Regex Authors |
| [pulldown-cmark](https://github.com/pulldown-cmark/pulldown-cmark) 0.12.2 | MIT | Copyright 2015 Google Inc. |
| [two-face](https://codeberg.org/CosmicHarper/two-face) 0.5.2, used under MIT | MIT OR Apache-2.0 | Copyright (c) 2023-2025 The `two-face` developers |

GPUIX's own
[THIRD_PARTY_NOTICES.md](https://github.com/remorses/gpuix/blob/main/THIRD_PARTY_NOTICES.md)
lists the files it ports from Comet. The syntax definitions two-face bundles
carry their own licenses, listed in its
[acknowledgements](https://codeberg.org/CosmicHarper/two-face/src/branch/main/generated/acknowledgements_full.md).
The binary also links other Rust crates from crates.io, each under its own
license; `cargo license` in gpuix's `packages/native` lists them.

## patches/@gpuix%2Freact@0.7.0.patch

A change to [`@gpuix/react`](https://github.com/remorses/gpuix) 0.7.0, licensed
under the Apache License 2.0. Bun applies it when the dependencies are
installed.

## License texts

The Apache License 2.0 is in [LICENSE](LICENSE). The components above marked
MIT are distributed under these terms, with the copyright lines listed:

```
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
```
