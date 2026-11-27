# Third-party notices — ReviewGate for Mac

The Mac app ships these components inside `ReviewGate.app/Contents/Resources`. Each is used under the licence named
below. The Swift packages the app links (SwiftTerm, Highlightr) carry their own notices in their repositories; the
Windows client's are in `clients/desktop/THIRD_PARTY_NOTICES.md`.

## The language server for JavaScript, TypeScript and Vue (docs/PROTOCOL.md §73)

Shipped in `Contents/Resources/dist/lsp`. The exact versions and every package's full licence text are in
`Contents/Resources/dist/lsp/LICENSES.md`, written by `scripts/build-lsp.mjs` from the packages that went into the build;
TypeScript's own `LICENSE.txt` and `ThirdPartyNoticeText.txt` are in `dist/lsp/node_modules/typescript`.

| Component | Version | Licence | Shipped as |
|---|---|---|---|
| TypeScript (tsserver) | 6.0.3 | Apache-2.0, with its ThirdPartyNoticeText | `dist/lsp/node_modules/typescript` (runtime files only) |
| @vue/typescript-plugin, @vue/language-core, vue-component-meta (Vue language tools) | 3.3.14 | MIT | bundled into `dist/lsp/node_modules/@vue/typescript-plugin/index.js` |
| @volar/typescript, @volar/language-core, @volar/source-map | 2.4.30 | MIT | the same bundle |
| @vue/compiler-core, @vue/compiler-dom, @vue/shared | 3.5.x | MIT | the same bundle |
| @babel/parser | 7.x | MIT | the same bundle |
| source-map-js | 1.x | BSD-3-Clause | the same bundle |
| entities | 7.x | BSD-2-Clause | the same bundle |
| alien-signals, muggle-string, path-browserify, picomatch, estree-walker | as bundled | MIT | the same bundle |
