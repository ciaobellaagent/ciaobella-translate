# Security and privacy

The local bridge is intended to run on the same computer as the browser. It binds to `127.0.0.1` and requires a random pairing credential; it also checks Host and browser Origin. Do not expose it as a public network service.

The official Codex process manages ChatGPT sign-in and refresh. This project does not copy OAuth credentials to the extension or accept API keys as a fallback. The source-controlled `extension/connection.json` is unpaired. A locally generated paired directory contains a separate loopback connection credential and must not be published.

Requested source paragraphs, source/target languages, model/effort selection, and supplemental translation instructions are sent to OpenAI and use the signed-in account's subscription allowance. Settings files and cached translations are stored locally. The cache contains translations and hashed identity keys, not a saved webpage. Paragraph content, languages, model, effort, and supplemental instructions affect cache identity. Translations and supplemental instructions can still contain sensitive information; keep the runtime directory private.

Visual exclusion rules are stored in browser-local extension storage as hostnames and structural selectors (up to 100 hostnames, 30 rules each). They are not synced or sent as rules to the model. Selected inline text and Latin @handles are replaced by placeholders before translation; surrounding source text is still submitted. A page-only exclusion lasts until navigation/reload. Remove persisted rules in Settings → 阅读与翻译 → 不翻译的内容.

By default runtime files live under `~/.local/state/workbench/luna-translate/`, with directory mode 0700 and sensitive files mode 0600. Do not attach that directory, raw stderr, pairing files, or browser profiles to issues. Tests use synthetic fixtures and mock model replies.

For a vulnerability, use the repository's private vulnerability reporting when available. If it is unavailable, open a minimal issue asking for a private contact without disclosing credentials, private text, or exploit details.
