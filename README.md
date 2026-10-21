# automerge-sync

Take notes in Obsidian. They show up on your other devices. There's a copy on
your server. Nothing merges by hand, because Automerge already solves that
problem better than I could write it in a weekend.

The idea: **a note is a CRDT document**. Your laptop edits it, your phone edits
it, the server keeps it. Automerge merges them. That's the whole product.

## How it works

Your vault dials each peer on a timer. Each round:

1. Ask the peer for its file list.
2. For every path in either vault, exchange Automerge sync messages until both
   sides agree.
3. Write the merged result back to disk.

Notes are markdown. Attachments are everything else, base64 inside their own
document, only re-sent when their content hash changes. A deleted file becomes a
tombstone so it doesn't come back next round.

Documents live in `.automerge-sync/` beside your notes. They're an
implementation detail — Obsidian doesn't index that folder.

## Settings

Settings → Automerge Sync.

| Setting | Default | Meaning |
|---|---|---|
| Sync automatically | on | Off means only the Sync now command syncs. |
| Sync every | 30 | Seconds between rounds. |
| Accept connections | off | Serve other vaults on this machine. |
| Port | 8521 | The listening port. |
| Peers | empty | Addresses of the other vaults, e.g. `ws://192.168.1.10:8521`. |

Every vault has the same settings. There's no "server" mode — the machine you
leave running is just the one with *Accept connections* turned on.

Two commands: **Sync now** (all peers, once). The status bar shows
`automerge: 12 files`, or the first error if a peer failed.

## Security, honestly

- **Nothing is encrypted.** Plain `ws://`. This is a LAN tool and I assume you
  trust your own network.
- **No peer authentication.** Anything that can reach the port can read and
  write your notes. Don't expose this to the internet, and don't run it on a
  network you don't control.
- I originally planned self-signed certs and fingerprint pinning, the way SSH
  does it. That needs an X.509 generator, and the only ones available pull in
  ~8 MB of `pkijs` and `@peculiar/x509` to make one certificate. Not worth it
  for a note sync on a home network. If you need transport security, put a
  reverse proxy in front and give the plugin `wss://` addresses — the protocol
  already works over TLS unchanged, since it's just WebSockets.

## Known limitations

- **Concurrent edits to the same paragraph resolve last-writer-wins.** That's
  Automerge's semantics for a string field. Character-level merging means
  storing note bodies as Automerge text sequences instead of strings — a
  one-line change in `Doc`, and the right eventual call, but not free.
- **Sync is per-round.** Open, exchange, close. Nothing is persistent between
  syncs, so the status bar describes the last round, not a live connection.
- **Attachments are base64 in the document.** A 4 MB image becomes a 5.3 MB
  string. It works and it round-trips exactly; it is not efficient.
- **Renames are create-new + delete-old.** Both propagate, but Obsidian's own
  rename events don't participate — we compare against the filesystem.

## Development

Node ≥ 20. If your shell has `NODE_ENV=production` set, npm quietly skips
devDependencies — use `env -u NODE_ENV npm install --include=dev`.

```sh
npm run check   # tests + typecheck + build + smoke test
npm test
npm run dev
```

`main.js` is self-contained — the Automerge WASM and `ws` are both bundled in.
Two files to copy, nothing else:

```sh
npm run build
cp main.js manifest.json <dev-vault>/.obsidian/plugins/automerge-sync/
```

## Layout

```
src/sync.ts      the protocol. pure — no Obsidian, no sockets
src/vault.ts     the only file that knows Obsidian exists
src/server.ts    the listener
src/settings.ts  the settings tab
src/main.ts      wiring
```

## References

- Automerge library initialization: https://automerge.org/docs/reference/library-initialization/
- `@automerge/automerge` 3.4.1: https://www.npmjs.com/package/@automerge/automerge
- Obsidian plugin docs: https://docs.obsidian.md/Plugins