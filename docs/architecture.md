# Architecture and configuration

```text
User activates translation
  → content script reads nearby paragraphs while keeping the source DOM
  → extension worker sends authenticated loopback requests
  → local bridge checks cache and schedules missing translation batches in a shared bounded pool
  → official Codex App Server uses the user's ChatGPT sign-in
  → selected model + effort produce validated structured translations
  → content script appends plain text below the original paragraph
```

The content script prefetches within 500px of the viewport, coalesces DOM changes, and skips controls, hidden text, code blocks, and its own output. Requests are bounded; stopping or restoring the page prevents late replies from being rendered. Already-started inference may finish and be cached. Queued work can be cancelled; stopping does not claim to interrupt active provider turns.

On `x.com` / `twitter.com` and their subdomains, the extractor only considers recognized readable regions: `tweetText` and `UserDescription` are atomic blocks, and `longformRichTextComponent` retains normal block ownership. Inline divs inside posts, including @mentions, are read with the entire post and never receive their own translation or progress node. Author regions, timestamps, buttons, and other interface areas are excluded. A standalone handle is not translated. Nested mutations rescan the atomic post root; responses are checked again before insertion in case the site recycled a node. Outside X, the general block extractor remains in use. Unsupported X regions remain original rather than falling back to translating every interface div.

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

## Parallel scheduling (v0.6)

`concurrency` is a persisted integer from 1 to 24, default 12. It changes the global bridge pool shared by all paired browsers/tabs; a page also limits outstanding batches to its last read configuration. Saving broadcasts the new limit to open pages in that browser. Other browsers read it on the next start; the bridge always enforces the current global cap. Lowering the limit lets existing calls finish. A 429/rate-limit/timeout error halves the effective cap for 30 seconds without changing the saved preference or silently retrying a failed call.

The page claims individual fragments, sends at most four fragments / 6000 characters per batch, and prioritizes actual viewport intersections over the 500px prefetch band. Intersection callbacks are coalesced before dispatch. Each batch has an epoch and claim identity, preventing old replies/finalizers from mutating a restarted or edited record. Scroll-away, pause and exclusion cancel obsolete queued jobs. Active calls may complete; cancellation is not a promise to recover already-spent usage. Pending bridge work is capped at 128 batches. Cached reads bypass the pool.

In-flight sharing uses the full cache key plus cache generation. Partially overlapping batches share fragment promises. A slot is held until its own inference completes even if a shared fragment fails. Model, effort and supplemental prompt remain snapshots of the accepted batch. The provider result is validated before caching; retries after failure do not inherit a rejected in-flight promise.

## User exclusions and block ownership (v0.6)

The generic extractor groups inline descendants and avoids inserting into non-semantic flex/grid containers (semantic paragraphs and headings remain eligible) and standalone control/link regions. This conservative rule can leave unsupported layouts untranslated; it is not universal semantic classification. Existing X component rules remain in force.

The picker generates independently authored candidates from stable-looking attributes/classes and nearby component structure. It never uses nickname text, concrete profile URLs or nth-child positions. It previews up to 200 current matches, allows a parent selection or single-element page-only exclusion, and saves only after a user action. A stable-looking selector can still become invalid after a site redesign; preview and removal are essential. Rules are limited to 30 per hostname and 100 hostnames in browser-local storage, not synced or sent to the model. Same-host routes and future matching elements reuse the rule; a subdomain is a different hostname.

Excluded paragraph roots are removed from work and their translations/progress disappear. Excluded inline text and Latin @handles use validated placeholders so the surrounding sentence is still translated. Literal text is restored with textContent; original links and nodes are retained. A wholly protected nickname produces no duplicate translation. Rules update open tabs via storage events; late replies cannot restore excluded content. Undo removes only the newly created rule or page-only exclusion; settings expose saved-rule removal.

Deterministic tests cover concurrency limits, partial-overlap sharing and failures, settings persistence, cancellation, generation isolation, viewport order, independent batch rendering, non-Luna models, dynamic exclusions, inline protection and undo. These do not prove live website pixel layout.
