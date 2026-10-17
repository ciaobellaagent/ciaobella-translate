# Ciao Bella Translate

![Ciao Bella Translate](extension/icons/bella.png)

An open-source bilingual webpage translator using your own local Codex / ChatGPT subscription. The browser extension keeps the original paragraphs and adds translations as you read, scroll, and expand content.

**Default: GPT-6 Luna + medium thinking effort.** Choose another available model or reasoning level in Settings → Subscription & connection. Model choices and effort bounds come from your installed Codex App Server, rather than a hard-coded product list. Usage is shared with your Codex subscription.

The extension is currently named **Luna 沉浸翻译**. The local bridge, Chromium extension, and tests are self-contained in this repository. This is an independent project, with no affiliation to OpenAI or Immersive Translate.

## What works

- Bilingual paragraphs with viewport-based batching, scrolling, expansion, and dynamic-content discovery.
- A draggable edge-docked button, per-paragraph waiting/processing indicators, pause, and restore-original controls.
- Configurable model, thinking effort, target language, supplemental translation instructions, and cache limits.
- Local cache: 7 / 30 / 90 days, 8 / 16 / 32 MiB, at most 10,000 fragments. Model, effort, languages, text, and instructions separate cache identities.
- Reopening a previously translated page restores available nearby cached translations. Missing content is translated only after you activate translation.
- Errors and limits pause translation. The selected model is checked; there is no automatic fallback to another model or translation provider.
- X / Twitter: translate each post or bio as a whole, including inline mentions; keep author names, handles, timestamps, action rows, and other interface text untouched. Recognized long-form article regions keep paragraph boundaries.

## Quick start

Requires Node.js 22+, an installed official [Codex CLI](https://learn.chatgpt.com/docs/cli), and your own ChatGPT sign-in with access to the selected model. **macOS is the tested platform.** The background-service installer uses launchd; foreground startup uses `npm start`, with manual setup on other platforms unverified. No npm runtime dependencies or API key are required.

```sh
git clone https://github.com/ciaobellaagent/ciaobella-translate.git
cd ciaobella-translate
codex login
npm run install-service
```

The installer verifies its own launchd job and loopback listener, then prints the paired extension directory. By default it is:

```text
~/.local/state/workbench/luna-translate/extension
```

The legacy runtime name is retained so existing installations keep their pairing, preferences, and cache.

1. Open `brave://extensions` or `chrome://extensions`.
2. Enable Developer mode, choose **Load unpacked**, and select the printed directory. In a macOS folder picker, press `⌘⇧G` to enter its full path.
3. Open a normal webpage and click the Ciao Bella **文／A** button. Hover or focus it to see progress, settings, and restore-original controls. The shortcut is `⌥⇧L` on macOS.
4. Open the extension's **Settings** to change model and thinking effort. Saving a new configuration resets open-page translations in that browser; click Translate again. Other browsers need their reading pages refreshed.

The paired directory contains a local connection credential. Do not redistribute it. `npm run package` creates an **unpaired** ZIP in `deliverables/`; every user must run their own bridge and use their own Codex login.

## Updating and stopping

After pulling changes, run `npm run install-service` to copy extension files, reload the extension in its management page, and refresh reading tabs. The installer does not interrupt an existing service. If bridge code changed, stop your own service first:

```sh
launchctl bootout gui/$(id -u)/com.workbench.luna-translate
npm run install-service
```

To disable login startup, stop the service and remove its `~/Library/LaunchAgents/com.workbench.luna-translate.plist`. To remove the extension, use the browser's management page. Moving the checkout can require reinstalling this launchd configuration; the installer deliberately refuses to overwrite a different configuration.

## Settings and cache

The model picker shows what the local Codex client reports; actual access is still checked when a translation starts. Efforts depend on the model. The tool-free translation engine does not expose agent-delegating Ultra mode. Higher reasoning effort can take longer and consume more of the shared usage allowance.

Switching models or effort uses a separate cache namespace. Switching back can reuse the previous namespace, subject to the same total space and age limits. Old Luna+low entries remain usable when low is selected; they are not reused as medium results. Reading a cached result updates recency, not its original expiry time.

Only the official Codex process reads and refreshes ChatGPT credentials. The extension gets a separate random loopback pairing credential. The bridge listens on `127.0.0.1`, validates Host, browser Origin, and pairing, and rejects API-key billing or unverified provider routes. Requested paragraphs, languages, model/effort selection, and supplemental translation instructions are sent to OpenAI. Settings files and cached translations are stored locally. See [Security & privacy](SECURITY.md).

## Scope and verification

The initial implementation was tried in a dedicated Chrome instance and loaded manually in Brave. Model selection has deterministic tests and a local App Server check. The X layout fix has synthetic DOM coverage and has not been checked live on X; this is not a claim of compatibility with every website or browser. PDF, image OCR, video subtitles, iframe / Shadow DOM text, store pages, and browser internal pages are outside the current scope.

```sh
npm ci --ignore-scripts # development/test dependencies only
npm run check
npm test
npm run package
```

Tests use Node's built-in runner, jsdom for synthetic DOM scenarios, and mock model responses. They do not spend subscription usage. The X fixture is authored test markup, not a captured webpage; DOM tests do not prove the current live site's pixel layout. Real browser/model checks are separate and opt-in. Architecture, settings semantics, and cache migration are documented in [docs/architecture.md](docs/architecture.md).

## Sources, license, and contributing

This implementation is original project code, with design and protocol references documented in [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md). That file identifies Immersive Translate, KISS Translator, open-immersive-translate, Codex App Server, and the language-symbol references, with their scope and upstream licenses. Brand artwork provenance is in [docs/branding/README.md](docs/branding/README.md).

Code and included artwork are licensed under [MIT](LICENSE). Trademark rights are not granted. Please preserve the attribution records, add regression tests for behavior changes, and keep pairing credentials and local runtime files out of contributions. See [CONTRIBUTING.md](CONTRIBUTING.md).
