---
name: automerge-sync
description: Obsidian plugin syncing vault notes as Automerge CRDT documents over WebSockets.
---

# automerge-sync

Syncs Obsidian vault notes as Automerge CRDT documents between vaults on a LAN.
A note is a CRDT document; edits made anywhere merge without a central
authority. `README.md` is the spec. This file is what an agent needs to work in
the tree.

## Layout

```
src/sync.ts      protocol: syncRound (dialer), servePeer (listener), wire adapter.
                 Pure — no Obsidian, no sockets, no timers.
src/vault.ts     the only file that imports obsidian. Folds files into
                 documents and back. Implements Store.
src/server.ts    ws listener. 47 lines.
src/settings.ts  the settings tab.
src/main.ts      lifecycle, the timer, the one command.
```

`Store` and `Wire` are the only two interfaces. Both are structural, so tests
supply plain objects and the Obsidian mock is a class-per-export stub.

## Invariants that cost debugging cycles

- **A missing local file must start as an EMPTY doc.** Writing an init change
  (`content: ""`) creates a concurrent LWW write that erases the peer's text on
  merge. This is the single most destructive bug in the design.
- **Deletion is a tombstone**, not a vanished file. "I have no file" and "it was
  deleted" look identical to a peer that never saw it, so without a `deleted`
  flag deletions resurrect on the next round.
- **Only persist a doc that has changes.** `Automerge.getAllChanges(doc).length`
  — otherwise paths that exist nowhere get materialized on both sides.
- **The listener must ACK `done`.** The initiator waits for it and deadlocks.
- **Seed a doc from the file on first sight.** A brand-new note syncs as an empty
  doc otherwise and its text never travels. "Sync says ok but the vault never
  changed" is almost always this.
- **Notes merge on mtime, attachments on content hash.** An untouched 4 MB image
  must cost one hash and no traffic.
- **The listener uses the same Store as the dialer.** It once served from an
  in-memory `Map`, so the "backup" accepted everything and wrote nothing. If
  anything ever reintroduces a second Store, that bug is back.
- **Assertions are about files, never `.amrg` bytes.** A test that only checks
  document blobs proves nothing about what the user sees.

## Automerge gotchas (verified, cost real time)

- **Load the WASM once**: `initializeBase64Wasm(automergeWasmBase64)` from
  `@automerge/automerge/slim`. Tests need this too — `tests/setup.ts` does it,
  and without it every call throws `Automerge.use() not called`.
- **`Doc<T>` is structurally `T`.** Use `type`, never `interface`, for document
  shapes: an interface lacks the implicit index signature `Automerge.from`
  requires. With a `type`, no casts are needed anywhere.
- **Automerge cannot hold a `Uint8Array`.** It converts one into a CRDT map of
  index keys, and it comes back as `{"0":1,...}`. Base64 is the only lossless
  option. Hence `Doc.content` is always a string.
- **`slim` has no default export.** `const { Automerge } = await import(...)`
  gives undefined; use `import * as Automerge`.

## Obsidian gotchas

- The `obsidian` package is **types-only**. vitest aliases it to
  `tests/mocks/obsidian.ts`; `TFile` must be a real class there because
  `vault.ts` uses `instanceof TFile`.
- **DOM tests need `// @vitest-environment jsdom`**, and the mock's
  `addStatusBarItem` must return something with `setText`.
- **Delete via `app.fileManager.trashFile`**, not `adapter.remove`, so the
  user's trash settings are respected. That's why `VaultIO` adds a `trash`
  method to `Vault`.
- **`ws` is bundled, not external — and that is deliberate.** An installed
  plugin folder has no `node_modules`, so a runtime `require("ws")` fails on
  load with `Cannot find module 'ws'` (this shipped, and it broke the plugin in
  Obsidian). The bundle is CJS with `platform: "node"`, which makes esbuild
  resolve `ws` to its real CommonJS build rather than the browser stub that
  lacks `WebSocketServer`. Don't "fix" this by re-adding `ws` to `external` —
  `tests/smoke.test.mjs` fails the build if a runtime require reappears.
- **`NODE_ENV=production`** in the shell makes npm skip devDependencies
  silently. Use `env -u NODE_ENV npm install --include=dev`.
- A listener that fails to start (port in use) must surface as a Notice and
  never reject `onload()`.

## Verify

```sh
npm run check   # 32 tests + tsc --noEmit + production build + smoke
```

Green is the gate. If a test fails because a helper returns a promise where the
code expects bytes (or vice versa), check that first — Automerge's `save`/`from`
are synchronous and it is easy to `await` them by mistake.