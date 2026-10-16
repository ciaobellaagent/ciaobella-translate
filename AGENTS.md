# Ciao Bella Translate

This repository owns a Chromium bilingual-reading extension and its local Codex subscription bridge. Start with README.md for setup and scope, docs/architecture.md for model/settings/cache behavior, and ACKNOWLEDGEMENTS.md for source provenance. External websites, the official Codex executable, and account credentials remain outside this repository.

Runtime code uses Node built-ins and browser extension APIs. `bridge/codex.mjs` handles the official App Server, `bridge/translate.mjs` owns the queue/cache, and `extension/` owns page controls and settings. Tests run with `npm test`; `npm run check` checks syntax, manifest scope, and the unpaired distribution boundary.

Model choices must be validated against local Codex capabilities. Preserve explicit model/effort selection, subscription-only authentication, no automatic provider/model fallback, and the rule that queued work retains its submitted configuration. Cache changes must keep model, effort, languages, and instructions isolated; legacy Luna+low results must not become medium results.

Source-controlled pairing files stay empty. Do not commit local runtime data or publish a paired extension. A passing mock test is not a live browser/model result; state the actual verification boundary. Contribution and notice requirements are in CONTRIBUTING.md and ACKNOWLEDGEMENTS.md.

Keep this file a short repository map. Put current progress in issues or release notes, detailed methods in docs, and regression checks in tests. Review exact diffs and read back the committed result when updating this contract.
