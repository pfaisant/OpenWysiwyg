# OpenWysiwyg

- Keep the default interface to the name, Rendered / HTML switch, and Settings.
- New controls and features belong behind opt-in settings. Do not add onboarding,
  subtitles, sample documents, advertisements, AI features, or promotional copy.
- Keep raw HTML as the source of truth. Merely switching views must not rewrite it.
- Never execute document scripts in the rendered editor. Keep sanitization and the
  isolated iframe's restrictive CSP and sandbox.
- Drafts stay in this browser. Do not add document uploads or analytics.
- All editing dependencies are self-hosted. Keep GPL source downloads and license
  notices with every build; update the exact upstream source manifest on upgrades.
- Run `npm run check`, `npm run build`, and `npm test` for editor changes. Check the
  actual interaction at 1280×800 and 390×844. Preserve unrelated work.
- Deployment is described in `deploy/README.md`. Use a separate immutable release;
  do not modify the AiConglomerate dashboard or reset its worktree.
