# Changelog

## 0.5.1 — 2026-10-17

- Fix X / Twitter author names, handles, and inline mentions being treated as separate paragraphs and receiving block translations that disrupt the original layout.
- Read post bodies and profile bios as complete units, retain paragraph boundaries in recognized long-form regions, and exclude author/UI metadata and standalone handles.
- Apply the same boundaries to cache restoration and dynamic updates; reject late insertions into recycled metadata nodes. Existing source links and text stay in place.
- Add an authored social-timeline fixture and six jsdom regression scenarios. jsdom is a test-only development dependency; runtime and distributed extension stay dependency-free.

Validation uses the actual content script with a simulated DOM, viewport, and model transport. It does not establish live X or Chromium pixel-layout compatibility.

## 0.5.0 — 2026-10-16

First public source release of Ciao Bella Translate (Luna 沉浸翻译).

- Default to GPT-6 Luna with **medium** thinking effort.
- Add model and effort selectors populated from local Codex capabilities, with unsupported combinations rejected and no automatic fallback.
- Isolate cached translations by model and effort, preserve legacy Luna+low entries, and snapshot queued work's configuration.
- Preserve settings drafts during rechecks and handle delayed responses or retired effort options without silently changing the saved selection.
- Retain viewport-progressive bilingual reading, expansion/dynamic-content discovery, local bounded cache, paragraph activity rings, and the selected Ciao Bella 08 icon.
- Publish MIT licensing, upstream design/protocol references, artwork provenance, privacy documentation, and a self-contained test suite.

Validation: 52 deterministic tests; syntax/package checks; one live Luna+medium translation followed by a cache hit without a second model request. The new selectors have not yet been verified in a live installed browser. The release is an early preview for macOS and unpacked Chromium extensions.
