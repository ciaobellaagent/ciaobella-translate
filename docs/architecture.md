# Architecture and configuration

```text
User activates translation
  → content script reads nearby paragraphs while keeping the source DOM
  → extension worker sends authenticated loopback requests
  → local bridge checks cache and serializes missing translation batches
  → official Codex App Server uses the user's ChatGPT sign-in
  → selected model + effort produce validated structured translations
  → content script appends plain text below the original paragraph
```

The content script prefetches within 500px of the viewport, coalesces DOM changes, and skips controls, hidden text, code blocks, and its own output. Requests are bounded; stopping or restoring the page prevents late replies from being rendered. One already-submitted batch may finish and be cached.

## Models and settings

The default pair is `gpt-6-luna` / `medium`. `model/list` supplies picker-visible text models and their supported reasoning levels. Agent-delegating Ultra is excluded because this translation engine disables tools and delegation. Availability in a model list is not a successful inference check; the actual thread/model/provider are checked and access errors are surfaced without fallback.

Settings writes are atomic and serialized. Model/effort validation checks the fully merged settings inside that serialized write, so concurrent partial updates cannot persist an invalid pair. Every accepted batch snapshots model, effort, and supplemental instructions. Later setting changes do not reinterpret queued batches.

The extension resets open-page translations after model, effort, or instruction changes in that browser. It retains unsaved settings drafts during connection checks, discards stale check responses after saves, and visibly preserves a saved effort that has become unavailable until the user selects a supported choice.

## Cache identity and migration

All variants share one bounded cache and one LRU order. Keys include source text, source/target languages, selected model, reasoning effort, and supplemental instructions. TTL is measured from generation; reads do not extend it.

The original prototype used Luna+low and v1/v2 key formats. Only that exact combination reuses legacy keys. Other model/effort pairs use v3 keys. The mixed cache envelope is version 2 and accepts old version-1 Luna entries without changing their generation time. Legacy settings version 1 gains the new default medium effort; new settings files use version 2.

Default storage is 32 MiB and 10,000 fragments, across all model variants. Atomic persistence can temporarily use another file of comparable size. Space and time limits, rather than the 30-day setting alone, bound accumulation. Pure LRU touches are batched; successful new translations are saved promptly.

## Local installation

The installer projects source files into the paired runtime extension directory and registers its own macOS launchd job. It refuses an unrelated port listener or a different existing job configuration. Its connection check does not initiate translation. Reloading the unpacked extension remains a browser-management action after files are updated.

The repository excludes the author's private browser-control infrastructure. Public deterministic tests run independently of that infrastructure. Real webpage/browser and live model checks are separate from `npm test`.
