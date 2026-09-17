# automerge-sync

Local-first Automerge document sync for Obsidian (milestone 1: local only, no networking).

## Architecture

```
src/main.ts                    Plugin class: init, commands, error reporting
src/automerge/
  AutomergeDocumentStore.ts    Pure Automerge layer: create/change/merge/encode/decode + store
  automergeTypes.ts            Re-exported Automerge types
src/persistence/
  VaultBinaryStore.ts          Binary I/O over Vault adapter (tmp-write → verify → final)
src/commands/sampleDocument.ts Create-or-update sample logic
src/ui/DocumentView.ts         Modal display (escaped text)
```

The Automerge layer never imports Obsidian — it takes a `BinaryStore` interface, so it's fully testable in Node.

**WASM strategy:** `@automerge/automerge/slim` + `@automerge/automerge/automerge.wasm.base64`, initialized exactly once via `initializeBase64Wasm()` in `onload()`. The WASM binary is embedded as base64 inside `main.js` (pure JS, ~4.8 MB) — no `.wasm` asset to ship, no `fetch`, no filesystem access. This is Automerge's documented path for JS-only environments (see [library initialization docs](https://automerge.org/docs/reference/library-initialization/)).

**Atomicity:** the Vault/DataAdapter API has no atomic rename, so writes go to `<path>.tmp`, are read back and byte-verified, then copied to the target. A failure before the final write leaves the old document intact. The verify→final window cannot be closed with the public API.

**Actor IDs:** each Automerge replica has a random actor ID. With a single vault file there is effectively one replica; actor IDs only matter once multiple devices sync (milestone 2).

## Commands

| Command | What it does |
|---|---|
| Create or update Automerge sample document | Creates `.automerge-sync/sample.automerge` or updates it through the service |
| Show Automerge sample document | Modal with escaped document content |
| Show raw Automerge byte length | Diagnostic: byte size of the persisted file |

## Development

Requires Node ≥ 20. Note: if your shell sets `NODE_ENV=production`, npm skips devDependencies — use `env -u NODE_ENV npm install --include=dev` or unset it.

```sh
npm install                 # install deps
npm test                    # vitest (16 tests: automerge, persistence, plugin boundary)
npm run build               # tsc --noEmit + esbuild production + smoke test
npm run check               # test + build
npm run dev                 # esbuild watch
```

## Install into a dev vault

1. Create/choose a **development vault** (never production).
2. Copy `main.js`, `manifest.json` into `<vault>/.obsidian/plugins/automerge-sync/`.
3. Enable "Automerge Sync" in Settings → Community plugins (disable restricted mode first).
4. Run the commands from the command palette.

## References

- Automerge library initialization (slim/base64): https://automerge.org/docs/reference/library-initialization/
- `@automerge/automerge` npm (3.4.1): https://www.npmjs.com/package/@automerge/automerge
- Obsidian sample plugin: https://github.com/obsidianmd/obsidian-sample-plugin
- Obsidian plugin docs: https://docs.obsidian.md/Plugins

## Known limitations / next steps

- No multi-device sync yet. Next: `@automerge/automerge-repo` with a storage adapter over `VaultBinaryStore` and a pluggable network adapter (e.g. syncserver or WebRTC); per-document actor IDs; Markdown sync is a separate concern and intentionally not conflated with Automerge document sync.
- No settings tab yet (path is fixed at `.automerge-sync/sample.automerge`).
- Atomic replacement is best-effort (see above).
