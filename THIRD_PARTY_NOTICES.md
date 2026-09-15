# Third-party notices

OpenWysiwyg's original code is Copyright (C) 2026 Paul Faisant and contributors,
licensed under GPL-2.0-or-later. The following independent projects retain their
copyrights and licenses. No premium TinyMCE plugins or cloud services are included.

| Component | License | Upstream |
| --- | --- | --- |
| TinyMCE 8.9.1 | GPL-2.0-or-later (the selected distribution option) | [Source](https://github.com/tinymce/tinymce/tree/f9dc8185c2d2f7c7d3759ecb569931cee7d530bb) · [License](https://github.com/tinymce/tinymce/blob/f9dc8185c2d2f7c7d3759ecb569931cee7d530bb/LICENSE.md) |
| CodeMirror 6, Lezer and supporting runtime packages | MIT | [CodeMirror](https://github.com/codemirror) · [Lezer](https://github.com/lezer-parser) |
| DOMPurify 3.4.15 | MPL-2.0 or Apache-2.0; used here under MPL-2.0 | [Source](https://github.com/cure53/DOMPurify/tree/3.4.15) · [MPL license](https://github.com/cure53/DOMPurify/blob/3.4.15/LICENSE-MPL) |
| DOMPurify 3.4.12, embedded in TinyMCE | MPL-2.0 or Apache-2.0; used here under MPL-2.0 | [Source](https://github.com/cure53/DOMPurify/tree/a9ca1e537422319a557a9a2aa61f003b23b4a197) |

TinyMCE: Copyright (c) 2025 Ephox Corporation DBA Tiny Technologies, Inc.
Its distribution also includes notices for DOMPurify, PrismJS and prism-themes;
the original `notices.txt` is preserved in the generated license download. That
file mentions DOMPurify 3.3.2, but `tinymce.js` and the source package identify
the embedded version as 3.4.12. Its matching source archive is hosted alongside
the TinyMCE source. The MPL and Apache license texts are included for both versions.
PrismJS and prism-themes are used by TinyMCE's code sample plugin, which this
application does not bundle or enable.
DOMPurify: Copyright (c) Cure53 and other contributors.
CodeMirror and Lezer: Marijn Haverbeke and contributors, with exact copyright
years preserved in each package's license.

`npm run build` copies the complete license and notice texts from every installed
runtime dependency into `dist/licenses.txt` and into `source.zip` under
`third-party-licenses/`. The generated list records exact versions, upstream
repositories and npm package integrity values from the lockfile. It also includes
the original DOMPurify TypeScript source under `vendor/dompurify/` in `source.zip`.

## Corresponding source

The deployed **Settings** links to the application source ZIP and license page.
That page also links to a locally hosted copy of the complete, unmodified TinyMCE
8.9.1 source repository, including its modules, build files and contribution
instructions. Its immutable commit, download URL and SHA-256 are recorded in
[`public/sources/manifest.json`](public/sources/manifest.json). The build verifies
this archive and refuses to package another installed TinyMCE version until its
source record is updated.

Build tools such as Vite and Playwright are development dependencies. Their own
license files are included in the packages installed by `npm ci`; the lockfile
records their exact versions.
