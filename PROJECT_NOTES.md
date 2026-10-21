# PROJECT_NOTES.md

A map of the code: what it does, in what order, and where the sharp edges
are. Every claim points at a file and line so you can jump straight there.

Read this top to bottom once and you'll know the whole plugin. It's 811 lines
across five files.

---

## 1. Architecture

Each vault syncs its notes to other vaults over WebSockets. **Every note is
its own Automerge CRDT document**, so if you edit the same note on two
devices, Automerge merges the edits. We never merge anything ourselves.

A sync round:

1. Dial the peer, ask for its file list
2. For every path in *either* vault, swap Automerge sync messages until both
   sides agree
3. Write the merged document back to the file on disk

That's it. The CRDT does conflict resolution. We move bytes.

### The shape of the system

```
┌──────────────────────── ONE VAULT ─────────────────────────┐
│                                                              │
│  Obsidian                                                     │
│    │                                                         │
│    │  files on disk                                           │
│    ▼                                                         │
│  ┌────────────────────────────────────────┐                  │
│  │  vault.ts          vaultStore()        │  ◄── implements  │
│  │  THE BRIDGE                            │      Store       │
│  │  file  ⇄  CRDT document                │                  │
│  └───────────────┬────────────────────────┘                  │
│                  │  Store.list/read/write                     │
│                  │  (one implementation, used by BOTH sides)   │
│                  │                                           │
│         ┌────────┴────────┐                                  │
│         │                 │                                  │
│         ▼                 ▼                                  │
│  ┌─────────────┐   ┌──────────────┐                           │
│  │  sync.ts    │   │  sync.ts     │                           │
│  │ syncRound() │   │ servePeer()  │   ◄── the protocol       │
│  │  (dials)    │   │ (listens)    │                           │
│  └──────┬──────┘   └──────▲───────┘                           │
│         │                 │                                   │
└─────────┼─────────────────┼───────────────────────────────────┘
          │                 │
          │           ┌─────┴──────┐
          │           │  server.ts │  ws listener
          │           └─────▲──────┘
          │                 │
   ═══════╪═════════════════╪══════ WebSocket ═════════════════
          │                 │
┌─────────┼─────────────────┼───────────────────────────────────┐
│         │           ┌─────┴──────┐                            │
│         │           │  main.ts   │  timer, settings, command   │
│         ▼           └────────────┘                            │
│   another vault  (identical structure)                        │
└──────────────────────────────────────────────────────────────┘
```

Three things to notice:

- **`vault.ts` sits in the middle and is used by both network paths.** The
  dialer and the listener call the *same* `Store`. This is why a note arriving
  from a peer lands on disk: there's only one code path from "bytes arrived" to
  "file written".
- **`sync.ts` knows nothing about Obsidian.** It takes a `Store` and a `Wire`.
  That's what makes the protocol testable in plain Node.
- **Both vaults are identical.** There's no "server" role and no "client" role.
  The machine you leave running just has *Accept connections* switched on.

### Startup — what happens when you enable the plugin

```
Obsidian              main.ts              sync.ts        vault.ts
   │                     │                    │               │
   │───onload()─────────>│                    │               │
   │                     │──initAutomerge()─>│               │
   │                     │   (loads WASM; every Automerge call │
   │                     │    before this throws)             │
   │                     │                    │               │
   │                     │──loadData()───────────────────────>│
   │                     │   (merge over defaults, ignore junk)│
   │                     │                                    │
   │                     │──ensureDocDir()───────────────────>│
   │                     │   (mkdir .automerge-sync)           │
   │                     │                                    │
   │                     │──addSettingTab / addCommand────────│
   │                     │──addStatusBarItem                  │
   │                     │                                    │
   │                     │──restart()──> main.ts:140           │
   │                     │      │                              │
   │                     │      ├─ if listen ────> server.ts:15
   │                     │      │    listen(store, port)         │
   │                     │      │                              │
   │                     │      └─ run()───────> main.ts:79     │
   │<────────────────────│   status bar painted                │
```

`store` is built in a field initializer (`main.ts:35`), which runs *before*
`onload` — it's why `bridge()` is called there rather than inside `onload`.

### A full sync round

This is the whole system doing its job. Laptop dials, server-vault listens.

```
Laptop (main.ts:102)              sync.ts:166            Server vault (server.ts:23)
   │                                  │                          │
   │ syncOne("ws://10.0.0.5:8521")    │                          │
   │   openSocket()      main.ts:174  │                          │
   │══════════════════════════════════╪══════════════════════════>│
   │                                  │                          │
   │──wire(...)  main.ts:110          │                          │
   │                                  │                          │
   │  1. "what do you have?"          │                          │
   │────── {t:"files"} ──────────────>│                          │
   │                                  │◀─ servePeer: sync.ts:223 │
   │      store.list()                │    store.list()          │
   │      vault.ts:178                │    vault.ts:178          │
   │<─── {t:"files.reply", paths} ────│──────────────────────────│
   │                                  │                          │
   │  2. union of both file lists     │                          │
   │     sync.ts:173                  │                          │
   │                                  │                          │
   │  3. for EACH path:               │                          │
   │     syncPath()  sync.ts:184      │                          │
   │────── {t:"open", path} ─────────>│                          │
   │                                  │  store.read(path)        │
   │      store.read(path)            │  vault.ts:184            │
   │      vault.ts:184                │                          │
   │◀──── {t:"sync", m} ─────────────│──── (repeat until both ──│
   │──── {t:"sync", m} ─────────────>│      sides have nothing │
   │◀──── {t:"sync", m} ─────────────│      left to send)       │
   │                                  │                          │
   │◀──── {t:"done", path} ───────────│──── peer ACK (REQUIRED)  │
   │      BOTH SIDES AGREE            │                          │
   │                                  │                          │
   │      hasContent(doc)?            │      hasContent(doc)?    │
   │      sync.ts:135                 │      sync.ts:135         │
   │                                  │                          │
   │      store.write(path, bytes)    │      store.write(...)    │
   │      vault.ts:205                │      vault.ts:205         │
   │           │                      │           │              │
   │           ▼                      │           ▼              │
   │     .amrg saved                  │     .amrg saved          │
   │     note.md updated              │     note.md updated      │
   │<══════════════════════════════════╪══════════════════════════│
   │                                  │                          │
   │  4. pipe.close()   main.ts:120    │                          │
   │───────────────────────────────>  │  session ends            │
```

The critical detail is in step 3: **the peer must send its own `done` back**
(`sync.ts:263`). The initiator is blocked waiting for it. Miss that ACK and you
get a 15-second timeout and a failed round, not a partial success.

### Converging one file — `syncPath()` at `sync.ts:184`

The loop that makes two divergent versions of a note become one.

```
        ┌────────────────── both sides run this loop ──────────────────┐
        │                                                            │
        │  [state, msg] = generateSyncMessage(doc, state)   :192     │
        │                                                            │
        │     msg exists?  ─── yes ──>  send {t:"sync"}      :196     │
        │         │                                                  │
        │         no                            sent done before?    │
        │         │                                  │              │
        │         └── not yet ──> send {t:"done"}    :197-201        │
        │                              │                           │
        │                              yes                         │
        │                              │                           │
        │  wait for a frame from the peer                  :203     │
        │         │                                                 │
        │    ┌────┴─────┬──────────────┐                           │
        │  "done"     "sync"        anything else                  │
        │    │           │              → throw          :211      │
        │    │           │                                          │
        │ we haven't    receiveSyncMessage                :214      │
        │ sent done?        │   (Automerge absorbs the change)       │
        │    │              │                                      │
        │   yes             └── loop again                         │
        │    │                                                     │
        │    ▼                                                     │
        │  both sides agree                                         │
        │  hasContent(doc)? ── yes ──> store.write()       :208     │
        │  return                                                 │
        └────────────────────────────────────────────────────────────┘
```

Two rules in that loop exist to prevent silent data loss:

- **`loadDoc` must return an EMPTY doc** when we have no bytes
  (`sync.ts:129`). Writing an init change (`content: ""`) instead would create
  a concurrent last-writer-wins write that **erases the peer's text on merge**.
- **Only save a doc that has changes** (`hasContent`, `sync.ts:135`). Otherwise
  a path that exists in neither vault gets materialized on both sides.

### The bridge — how a file becomes a document and back

This is the part that's easy to get wrong, and the part that determines
whether sync does anything visible.

```
READ — store.read(path)  vault.ts:184
══════════════════════════════════════════════════════════════════

  file exists?
      │
      ├── yes ──> importFile()                    vault.ts:100
      │             │
      │             ├── no .amrg yet ─────> seed from the file     :103
      │             │                        (first sight; without
      │             │                         this the note's text
      │             │                         never leaves the vault)
      │             │
      │             ├── .md, mtime unchanged ──> return as-is      :124
      │             │
      │             ├── .md, mtime changed ──> Automerge.change    :126
      │             │                          fold in your edit
      │             │
      │             ├── image, hash same ──> return as-is          :135
      │             │                        (untouched: ZERO traffic)
      │             │
      │             └── image, hash differs ─> Automerge.change    :136
      │                                            fold in new bytes
      │
      └── no ──> load the stored .amrg
                  ├── no doc at all ──> return null      :192
                  │                      (never seen this path;
                  │                       empty doc is correct,
                  │                       and MUST stay empty)
                  ├── already deleted ─> return it       :193
                  └── still there ────> TOMBSTONE it      :198
                                       deleted=true, content=""
                                       (so the deletion travels
                                        instead of resurrecting)


WRITE — store.write(path, bytes)  vault.ts:205
═════════════════════════════════════════════════════════════

  ensureDocDir()                              :206
  writeBinary(docPath(path), bytes)           :207  save the CRDT doc
  exportDoc(path, load(bytes))                :208  now push to the file
      │
      ├── doc.deleted ──────> trash the file          :147  deletions propagate
      │
      ├── note, text differs ──> vault.modify()      :153
      ├── note, text same ──────> skip entirely      :153  no needless writes
      │
      ├── image, hash differs ──> writeBinary()      :163
      ├── image, hash same ─────> skip               :163
      │
      └── file doesn't exist here ──> CREATE it      :170
            ├── note       → vault.create()
            └── attachment → writeBinary()

---

## 2. Files, in dependency order

Read them in this order — each only depends on the ones above it.

| File | Lines | Knows about | Job |
|---|---|---|---|
| `src/sync.ts` | 266 | nothing (pure) | The wire protocol. Two entry points: `syncRound` (dialer) and `servePeer` (listener). |
| `src/vault.ts` | 210 | Obsidian | Converts files ⇄ CRDT documents. Implements `Store`. |
| `src/server.ts` | 48 | `ws`, Node | Accepts inbound connections. 30 lines of real code. |
| `src/settings.ts` | 103 | Obsidian | The settings tab. |
| `src/main.ts` | 185 | Obsidian, Node | Wiring, the timer, the command. |

Two interfaces hold it together. Everything else is a function:

```ts
interface Store {                    // sync.ts:38 — where documents live
  list(): Promise<string[]>;
  read(path: string): Promise<Uint8Array | null>;   // returns a SAVED doc
  write(path: string, bytes: Uint8Array): Promise<void>;
}

interface Wire {                     // sync.ts:45 — a byte pipe
  send(bytes: Uint8Array): Promise<void>;
  recv(): Promise<Uint8Array | null>;   // null = socket died
  close(): Promise<void>;
}
```

`Store` is implemented once (`vault.ts:67`) and used by **both** sides of the
network. That's the single most important design decision in the project — the
listener and the dialer share one implementation, so a note that arrives from a
peer goes through exactly the same code as a note you just typed.

---

## 3. Startup: what happens when you enable the plugin

`main.ts:54` `onload()`:

```
initAutomerge()                              main.ts:55
  → sync.ts:16   loads the WASM blob. ONCE per process. Every Automerge call
                 before this throws "Automerge.use() not called".

loadConfig(await this.loadData())            main.ts:56
  → main.ts:20   merges data.json over defaults, ignoring junk. A hand-edited
                 or truncated settings file cannot crash the plugin.

ensureDocDir(this.app.vault.adapter)          main.ts:57
  → vault.ts:59  creates .automerge-sync/ if missing.

this.store = vaultStore(this.bridge())        main.ts:35  (field initializer,
                                                          runs BEFORE onload)
  → vault.ts:67  builds the Store. `bridge()` (main.ts:47) glues Obsidian's
                 vault to a `trash` method, because Obsidian has no
                 vault-level delete.

addSettingTab / addCommand / addStatusBarItem  main.ts:59-66
restart()                                     main.ts:67  → main.ts:140
```

`restart()` (`main.ts:140`) tears down the old listener and timer, starts a
listener if enabled, saves settings, and calls `run()`.

---

## 4. The timer loop

`main.ts:79` `run()` — called once, then re-schedules itself forever.

```
if (!config.sync) → paint("automerge: off"), STOP        main.ts:80-83
    ↑ Note: it returns WITHOUT rescheduling. Turning sync back on only works
      because the settings tab calls restart().

Promise.all(peers.map(syncOne))          main.ts:85   all peers in parallel
  → main.ts:102  syncOne(address)
       openSocket(address)                main.ts:174  wraps the WebSocket
       wire(...) + event listeners        main.ts:110
       syncRound(store, pipe)             sync.ts:166
       pipe.close()                       main.ts:120

paint status                               main.ts:91
delay = failed ? min(interval*2, 5min) : interval     main.ts:97
setTimeout(run, delay)                    main.ts:98
```

The backoff (`main.ts:97`) is the important bit: a peer that's off doubles the
wait each round up to 5 minutes, and one success resets it. Without it, an
unplugged peer gets hammered every 30 s forever.

**Status bar text** is built at `main.ts:91-95`. `paint()` (`main.ts:165`)
skips the DOM write when the text hasn't changed, so it doesn't thrash.

---

## 5. One sync round, step by step

`sync.ts:166` `syncRound(store, peer)` — never throws, always returns a result.

```ts
type Round = { ok: true; files: number } | { ok: false; files: number; error: string }
// sync.ts:152
```

```
1. send {t:"files"}                            sync.ts:169
2. recv files.reply, check the type            sync.ts:170-171
3. union = Set(my paths ++ their paths)        sync.ts:173
4. for each path: syncPath(...)                sync.ts:174
5. return {ok:true, files}                     sync.ts:177
   any throw → return {ok:false, error}        sync.ts:178-180
```

### The frame format

`sync.ts:106-124`. Five frame types, JSON header with a 4-byte length prefix:

| Frame | Meaning |
|---|---|
| `{t:"files"}` | "what do you have?" |
| `{t:"files.reply", paths:[...]}` | the answer |
| `{t:"open", path}` | "let's work on this file" |
| `{t:"sync", path, m}` | one Automerge sync message, base64 |
| `{t:"done", path}` | "I have nothing left to send" |

The length prefix (`encodeFrame`, `sync.ts:113`) exists so a reader knows
where the JSON stops. It's how you get a frame out of a byte stream that
doesn't respect message boundaries.

### Per-file convergence

`sync.ts:184` `syncPath()` — the core loop.

```
send {open, path}                    sync.ts:185
doc  = loadDoc(await store.read(path))   sync.ts:187
state = Automerge.initSyncState()        sync.ts:188

loop up to 100 times:
  [state, msg] = generateSyncMessage(doc, state)      sync.ts:192
  if msg       → send {sync}                            sync.ts:196
  else if !done_sent → send {done}                      sync.ts:197-201

  recv a frame                                        sync.ts:203
  if {done}:
      if we hadn't sent done → keep looping            sync.ts:206
      else → both agree. Save if the doc has changes.  sync.ts:208
             return
  if {sync} → receiveSyncMessage, absorb it            sync.ts:214
throw "did not converge in 100 rounds"                  sync.ts:216
```

Three invariants live in those 30 lines, and all three are load-bearing:

- **`loadDoc` returns an EMPTY doc when we have no bytes** (`sync.ts:129-130`).
  Writing an init change (`content: ""`) instead would create a concurrent
  LWW write that **erases the peer's text on merge**. This is the single most
  destructive bug possible in this design, and the comment at `sync.ts:126-128`
  exists only to warn about it.
- **The responder must ACK `done`** (`sync.ts:263`). The initiator is waiting
  for it; no ACK means a 15-second timeout and a failed round.
- **Only save a doc that has changes** (`hasContent`, `sync.ts:135`, checked at
  `sync.ts:208` and `sync.ts:254`). Otherwise paths that exist nowhere get
  materialized on both sides.

---

## 6. The listener

`server.ts:15` `listen(store, port)` — 48 lines total.

```ts
const wss = new WebSocketServer({ port });            // server.ts:16
wss.on("connection", (ws) => {                       // server.ts:23
  ws.binaryType = "arraybuffer";                     // server.ts:24
  const { wire, push, hangup } = wire(...)           // server.ts:25
  ws.on("message", d => push(new Uint8Array(d)))     // server.ts:29
  ws.on("close", hangup)                             // server.ts:30
  servePeer(pipe, store).catch(...)                  // server.ts:33
});
```

`servePeer` (`sync.ts:223`) is the mirror image of `syncRound` — same frames,
same `Store`, just reacting instead of initiating. The switch at
`sync.ts:233` handles `files`, `open`, `sync`, `done`.

**A failure anywhere in `servePeer` tears down the connection** (`server.ts:33-36`).
One malformed frame kills the session. That's deliberate — a half-synced session
is worse than a reconnect.

---

## 7. The vault bridge — where files become documents

`vault.ts:67` `vaultStore(vault)`. This is the only file that imports
`obsidian` (`vault.ts:15`).

### Layout on disk

```
notes/idea.md                    ← your actual note
notes/img/diagram.png            ← your actual image
.automerge-sync/notes_idea.md.amrg        ← the CRDT doc for idea.md
.automerge-sync/notes_img_diagram.png.amrg ← the CRDT doc for the image
```

`docPath()` (`vault.ts:33`) flattens the path into one filename. The real path
is stored *inside* the document, because the flattening isn't reversible (`_` is
a legal character in a real filename).

### Reading — `store.read(path)` (`vault.ts:184`)

```
file exists?
  YES → importFile(file)                          vault.ts:186
  NO  → load the stored doc
         no doc at all  → return null             vault.ts:192
         already deleted → return it              vault.ts:193
         otherwise → TOMBSTONE it                 vault.ts:197-202
```

`importFile` (`vault.ts:100`) is where your edits get folded into the CRDT:

| Case | Line | Rule |
|---|---|---|
| No doc yet | `vault.ts:103-120` | Seed from the file. Without this a brand-new note syncs as an empty doc and its text never leaves the vault. |
| Markdown, `mtime <= stored` | `vault.ts:124` | Nothing changed. Return the doc untouched. |
| Markdown, `mtime > stored` | `vault.ts:126-129` | You typed. `Automerge.change` folds the new text in. |
| Attachment, hash same | `vault.ts:135` | Untouched image. Return early — **zero traffic**. |
| Attachment, hash differs | `vault.ts:136-140` | Replaced image. Fold in the new bytes. |

That hash check at `vault.ts:134-135` is what keeps a 4 MB PNG from being
re-sent every round. It costs one SHA-256 over the file.

### Writing — `store.write(path, bytes)` (`vault.ts:205`)

```
ensureDocDir()                                    vault.ts:206
writeBinary(docPath(path), bytes)                 vault.ts:207  save the CRDT doc
exportDoc(path, Automerge.load(bytes))            vault.ts:208  now push to the file
```

`exportDoc` (`vault.ts:144`) is the mirror:

| Case | Line | Rule |
|---|---|---|
| `doc.deleted` | `vault.ts:147-150` | Trash the file. This is how deletions propagate. |
| Note, text differs | `vault.ts:153` | `vault.modify()` |
| Note, text same | `vault.ts:153` | Skip the write entirely. |
| Attachment, hash differs | `vault.ts:163-165` | Overwrite the bytes. |
| File doesn't exist here | `vault.ts:170-174` | Create it — note via `vault.create`, attachment via `writeBinary`. |

### Attachments are base64

`Doc.content` (`sync.ts:29`) is **always a string** — markdown text for a note,
base64 for an attachment. This is not a style choice: Automerge cannot hold a
`Uint8Array`. It converts one into a CRDT map keyed by index, and `load` gives
you back `{"0":1,"1":2}`. Base64 is the only lossless option. Encoded at
`vault.ts:49`, decoded at `vault.ts:51`.

Cost: a 4 MB image becomes a 5.3 MB string. It works, it round-trips exactly,
it is inefficient. Say so rather than pretending otherwise.

---

## 8. Confirmed bugs

These are not speculation. Each was reproduced by running the code; the
output is quoted.

### 🔴 1. Any attachment over ~100 KB crashes the round

`sync.ts:99` and `vault.ts:49`:

```ts
export const bytesToBase64 = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b));        // ← spread
```

`String.fromCharCode(...b)` passes one argument per byte. JavaScript has an
argument limit around 65–125 k. Past it you get `RangeError`.

Measured:

```
size 50000:  ok
size 200000: RangeError
size 2000000: RangeError
```

And end to end, a 2 MB PNG through a real sync round:

```
ROUND: { ok: false, files: 0, error: 'Maximum call stack size exceeded' }
arrived bytes: MISSING
```

**So: any image over ~100 KB never syncs.** If you have screenshots in your
notes, this is almost certainly what "still broken" means. Two call sites to
fix — chunk the conversion instead of spreading.

### 🔴 2. `.automerge-sync/` is enumerated as vault files

`vault.ts:180`:

```ts
const live = vault.getFiles().map((f) => f.path);
```

Real Obsidian's `getFiles()` returns **every** file in the vault, including the
`.amrg` documents we wrote ourselves. There is no filter. With a real vault:

```
LISTED: [ 'note.md', '.automerge-sync/note.md.amrg' ]
docs leaked into list(): [ '.automerge-sync/note.md.amrg' ]
```

So every round re-syncs the plugin's own bookkeeping files as if they were
notes. `importFile` will try to base64-encode a binary blob and treat it as an
attachment — feeding the bug above. My fake vault filtered these out, which is
why 32 tests passed while this was broken. **The test helper was lying.**

Fix: exclude paths starting with `.automerge-sync/` at `vault.ts:180`, and
teach the fake vault to stop hiding it.

### 🟠 3. Doc filenames collide

`vault.ts:33` replaces every unsafe character with `_`:

```
a/b.png  →  .automerge-sync/a_b.png.amrg
a_b.png  →  .automerge-sync/a_b.png.amrg     ← same file
```

Measured — writing both produced exactly one doc file:

```
DOC FILES for a/b.png and a_b.png: [ '.automerge-sync/a_b.png.amrg' ]
```

Two different attachments silently overwrite each other's CRDT history. Rare,
but it corrupts data. Needs a reversible encoding (percent-encode, or hash the
path into the filename).

### 🟠 4. `mkdir` isn't recursive

`vault.ts:171`:

```ts
if (dir) await vault.adapter.mkdir(dir);
```

Obsidian's `mkdir` throws `ENOENT` if the parent doesn't exist. A note arriving
at `deep/nested/note.md` fails:

```
mkdir calls: [ '.automerge-sync' ] | error: ENOENT deep/nested
```

Any folder created by a peer must already exist locally, or the file is never
created. Needs a loop over `parentOf` ancestors.

### 🟡 5. Turning sync off stops the loop permanently

`main.ts:80-83` — when `sync` is false, `run()` returns without scheduling
another round. It restarts only because the settings tab calls `restart()`.
That's currently fine, but it's a hidden coupling: any future path that sets
`config.sync = false` without calling `restart()` leaves sync dead with no
error.

---

## 9. Things that look wrong but aren't

**`tsconfig.json` has `"allowJs": true` and a very old `lib` list.** Cosmetic.

**`docs/AGENTS.md` exists separately from this file.** It holds the invariants
and the environment traps; this file is the tour. Both are worth reading.

**`tests/setup.ts` is 7 lines** and does one thing: calls `initAutomerge()`.
Without it every test throws `Automerge.use() not called`. It's referenced from
`vitest.config.ts` as `setupFiles`.

**`wire()` returns an object with `push`/`hangup`** (`sync.ts:86-96`) rather than
the socket having methods. That shape exists so both socket libraries fit it:
the DOM `WebSocket` (via `addEventListener`) and Node's `ws` (via `on`). Typing
the helper against the DOM `WebSocket` instead would make `ws` a special case
needing a cast.

**The `Doc` type uses `type`, not `interface`** (`sync.ts:27`). `Doc<T>` is
structurally identical to `T`, but an `interface` has no implicit index
signature, so `Automerge.from<Doc>()` rejects it and the "fix" is a cast that
infects the whole file. With `type`, there are **zero `as unknown as` casts in
all of `src/`**.

---

## 10. Where to make changes

| To change... | Edit |
|---|---|
| The wire protocol / add a frame type | `sync.ts:106` (Frame), `:233` (servePeer switch), `:184` (syncPath) |
| What counts as a note vs an attachment | `vault.ts:27` (`isNote`) |
| How file edits are detected | `vault.ts:100` (`importFile`) |
| Where documents are written | `vault.ts:33` (`docPath`) |
| The sync interval / backoff | `main.ts:97` |
| The status bar text | `main.ts:91-95` |
| Settings shown to the user | `settings.ts:23` (`display`) |
| The shipped bundle | `esbuild.config.mjs` — see the `platform: "node"` note in `docs/AGENTS.md` |

**When you touch `sync.ts`, keep these three intact:** the empty-doc rule
(`sync.ts:129`), the `done` ACK (`sync.ts:263`), and the has-changes check
(`sync.ts:135`). They are the difference between working sync and silently
destroying your notes.

---

## 11. Verify

```sh
npm run check     # 32 tests + typecheck + build + smoke test
npm test
```

Green means: the protocol converges, the bridge writes files, the plugin
loads. It does **not** mean the four bugs above are fixed — those are real and
the tests don't cover them. Add a test with each fix.