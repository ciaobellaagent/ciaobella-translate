# Changelog

## 0.5.0 — 2026-10-16

First public source release of Ciao Bella Translate (Luna 沉浸翻译).

- Default to GPT-6 Luna with **medium** thinking effort.
- Add model and effort selectors populated from local Codex capabilities, with unsupported combinations rejected and no automatic fallback.
- Isolate cached translations by model and effort, preserve legacy Luna+low entries, and snapshot queued work's configuration.
- Preserve settings drafts during rechecks and handle delayed responses or retired effort options without silently changing the saved selection.
- Retain viewport-progressive bilingual reading, expansion/dynamic-content discovery, local bounded cache, paragraph activity rings, and the selected Ciao Bella 08 icon.
- Publish MIT licensing, upstream design/protocol references, artwork provenance, privacy documentation, and a self-contained test suite.

Validation: 52 deterministic tests; syntax/package checks; one live Luna+medium translation followed by a cache hit without a second model request. The new selectors have not yet been verified in a live installed browser. The release is an early preview for macOS and unpacked Chromium extensions.
