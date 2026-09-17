# OpenWysiwyg

A local HTML editor at [wysiwyg.pfa87.cc](https://wysiwyg.pfa87.cc).

Start with a blank page. Paste HTML, Markdown or plain text; the header shows
the detected format. Click that label to choose a format manually. Switch between
**Rendered** and your source, or press
**Ctrl/Cmd + Shift + E**. Settings holds everything else: formatting tools, split
view, file actions, word count and line numbers. Enable them when needed.
When split view is enabled, **Settings → Split order** chooses which editor goes
on the left. On a small screen, the left editor appears on top. The choice is
remembered in this browser.

Your draft and settings stay in this browser's local storage. There is no account,
document server, advertising or AI integration. Download HTML to keep a separate
copy; clearing browser storage removes the local draft.

Markdown supports headings, lists, tables, links, tasks and fenced code. Its source
stays unchanged when switching views. **HTML** shows generated markup without
replacing the original Markdown. Visual edits update Markdown using standard GFM
syntax; formatting that Markdown cannot represent can change during a visual edit.

Enable **File actions** in Settings to show the compact **Documents** menu:
**Copy HTML code** copies literal markup, **Copy Markdown** copies Markdown, and
**Copy formatted text** is for pasting rich content into Word or email. **Download**
keeps the current source format; **Download HTML** exports HTML. `.md`, `.markdown`,
`.html`, `.htm` and `.txt` files are supported. Existing browser drafts are retained
and detected again on load.

Switching views preserves the original HTML. The rendered editor does not execute
document scripts. Visual edits sanitize and rewrite the document body, so unsupported
or unsafe markup can change when you edit visually. HTML mode remains available
for working on the original source directly.

Complete HTML documents render with their own styles and browser defaults, using
the full pane width. HTML fragments get a simple sans-serif editing style. Editor
padding and typography are never written into your source.

The local Workbench tool embeds the editor in place, with compact dark controls
and a document canvas that keeps the document's own colors. See
[local deployment](deploy/README.md#windows-local-deployment-and-workbench).

## Development

Requires Node.js 22.12 or newer and npm.

```sh
npm ci
npm run dev
```

## Build and serve

```sh
npm run build
npm run preview
```

Deploy the contents of `dist/` to a static web server. The build includes all editor
assets locally; no CDN or Tiny Cloud key is required. `scripts/serve.mjs` provides
the deployment server when a Node service is preferred.

The build also creates `source.zip`, `licenses.txt` and copies of the exact TinyMCE
and embedded DOMPurify source archives under `sources/`. It downloads these from
GitHub on the first build, verifies their recorded SHA-256 values, and caches them in
`node_modules/.cache/openwysiwyg/`. A missing or mismatched archive fails the build.
Keep these source and license files with the deployed application. The source ZIP
contains the application and build inputs; `npm ci` installs the dependency versions
recorded in `package-lock.json`.

```sh
npm run check
npx playwright install chromium
npm test
```

## Open source

OpenWysiwyg is licensed under **GPL-2.0-or-later**. It uses self-hosted
[TinyMCE](https://github.com/tinymce/tinymce) for visual editing,
[CodeMirror](https://codemirror.net/) for HTML and
[DOMPurify](https://github.com/cure53/DOMPurify) for sanitizing rendered content.
Markdown conversion uses [Marked](https://marked.js.org/),
[Turndown](https://github.com/mixmark-io/turndown) and its GFM plugin.
The simple switching interface also takes inspiration from
[wysi](https://wysi.js.org/); no wysi source is copied.

See [LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
the application's **Settings → Licenses** page. The public repository is
[pfaisant/OpenWysiwyg](https://github.com/pfaisant/OpenWysiwyg).
