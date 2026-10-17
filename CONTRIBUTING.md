# Contributing

Use Node.js 22 or newer. Runtime code needs no npm packages. Install the locked development dependencies for the deterministic tests; jsdom supplies DOM APIs without starting a browser or loading external webpages.

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Keep changes focused and explain the user-visible behavior and validation. Add useful regression coverage for cache identity, queue snapshots, model capability validation, settings persistence, or DOM behavior. Avoid tests that only repeat implementation constants.

All test fixtures must be authored or clearly licensed, contain no private webpage content, and avoid real model calls. A live model check spends shared subscription usage and should be an explicit, small validation step.

Keep `extension/connection.json` unpaired. Exclude runtime caches, login files, browser profiles, local test logs, and paired distribution folders. Preserve [source attribution](ACKNOWLEDGEMENTS.md), and include license notices for any third-party material you add.

The 08 artwork is the currently adopted identity. Preserve its source and provenance when resizing assets; propose character changes separately. Included raster artwork has an opaque ivory background and should not be described as editable vector artwork.
