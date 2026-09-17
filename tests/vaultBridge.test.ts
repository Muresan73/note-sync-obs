// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import { VaultSyncStore } from "../src/main";
import { VaultBinaryStore } from "../src/persistence/VaultBinaryStore";
import { initSyncAutomerge, encodeNoteDoc, decodeNoteDoc, applyEdit } from "../src/sync/SyncEngine";

/**
 * VaultSyncStore tests: the bridge between markdown files and automerge
 * docs — WITHOUT Obsidian. We fake the minimal Vault file surface.
 */

beforeAll(async () => {
	await initSyncAutomerge();
});

type FakeFile = { path: string; stat: { mtime: number } };

function fakeVault(notes: Map<string, string>) {
	const files = new Map<string, FakeFile>();
	for (const p of notes.keys()) files.set(p, { path: p, stat: { mtime: 100 } });
	return {
		files,
		notes,
		getMarkdownFiles(): FakeFile[] {
			return [...files.values()];
		},
		getAbstractFileByPath(path: string): FakeFile | null {
			return files.get(path) ?? null;
		},
		async read(file: FakeFile) {
			return notes.get(file.path) ?? "";
		},
		async modify(file: FakeFile, data: string) {
			notes.set(file.path, data);
			// Simulate Obsidian updating mtime on write.
			files.get(file.path)!.stat.mtime = Date.now();
		},
		async create(path: string, data: string) {
			const f = { path, stat: { mtime: Date.now() } };
			files.set(path, f);
			notes.set(path, data);
			return f as never;
		},
	};
}

function fakeBinaryStore() {
	const blobs = new Map<string, Uint8Array>();
	const adapter = {
		exists: vi.fn(async (p: string) => blobs.has(p)),
		readBinary: vi.fn(async (p: string) => blobs.get(p)!.slice().buffer as ArrayBuffer),
		writeBinary: vi.fn(async (p: string, data: ArrayBuffer) => {
			blobs.set(p, new Uint8Array(data.slice(0)));
		}),
		mkdir: vi.fn(async () => {}),
	};
	return { adapter, blobs, store: new VaultBinaryStore(adapter as never) };
}

function makeStore() {
	const vault = fakeVault(new Map([["note.md", "original text"]]));
	const binary = fakeBinaryStore();
	const store = new VaultSyncStore(binary.store, vault as never);
	return { vault, binary, store };
}

describe("VaultSyncStore: markdown ↔ automerge bridge", () => {
	it("imports fresh markdown text into the doc when the file changed on disk", async () => {
		const { vault, store } = makeStore();

		// First readDoc on a note with no doc seeds one FROM the markdown
		// (this is what makes the first sync carry the note's text).
		const seeded = decodeNoteDoc((await store.readDoc("note.md"))!);
		expect(seeded.content).toBe("original text");
		expect(seeded.updatedAt).toBe(100);

		// Seed a doc whose content matches an OLDER version of the note
		// (doc.updatedAt < file mtime → stale).
		const old = encodeNoteDoc({ path: "note.md", content: "original text", updatedAt: 50 });
		await store.writeDoc("note.md", old);

		// User edits the note in the vault afterwards.
		vault.notes.set("note.md", "edited in vault");
		vault.files.get("note.md")!.stat.mtime = 200;

		const bytes = await store.readDoc("note.md");
		const doc = decodeNoteDoc(bytes!);
		expect(doc.content).toBe("edited in vault"); // imported
		expect(doc.updatedAt).toBe(200);
	});

	it("does NOT re-import when the markdown is unchanged (mtime guard)", async () => {
		const { vault, store } = makeStore();
		// Content matches the note on disk ("original text"), mtime matches
		// doc.updatedAt (100) → no import, stored bytes unchanged.
		const seeded = encodeNoteDoc({ path: "note.md", content: "original text", updatedAt: 100 });
		await store.writeDoc("note.md", seeded);
		const bytes = await store.readDoc("note.md");
		// byte-identical: no extra change was appended
		expect(Buffer.from(bytes!).equals(Buffer.from(seeded))).toBe(true);
		void vault;
	});

	it("writes merged doc content back to the markdown file when it differs", async () => {
		const { vault, store } = makeStore();
		// Simulate a merged doc arriving from sync with different content.
		const merged = applyEdit(
			encodeNoteDoc({ path: "note.md", content: "original text", updatedAt: 100 }),
			(d) => {
				d.content = "merged from remote";
			},
		);
		await store.writeDoc("note.md", merged);
		expect(vault.notes.get("note.md")).toBe("merged from remote"); // exported!
	});

	it("leaves the markdown untouched when content already matches", async () => {
		const { vault, store } = makeStore();
		const spy = vi.spyOn(vault, "modify");
		const same = encodeNoteDoc({ path: "note.md", content: "original text", updatedAt: 100 });
		await store.writeDoc("note.md", same);
		expect(spy).not.toHaveBeenCalled();
		expect(vault.notes.get("note.md")).toBe("original text");
	});

	it("creates the markdown file when a synced note does not exist locally", async () => {
		const { vault, store } = makeStore();
		const remote = encodeNoteDoc({
			path: "from-remote.md",
			content: "born elsewhere",
			updatedAt: 1,
		});
		await store.writeDoc("from-remote.md", remote);
		expect(vault.notes.get("from-remote.md")).toBe("born elsewhere");
		expect(vault.files.has("from-remote.md")).toBe(true);
	});

	it("end-to-end: vault A edit reaches vault B's markdown through one sync round", async () => {
		// Two full bridge instances (as the plugin builds them) + hub.
		const { startRelayServer } = await import("../src/sync/relayServer");
		const { SyncEngine } = await import("../src/sync/SyncEngine");
		const { WebSocketConnectionFactory } = await import("../src/sync/WebSocketTransport");
		const { WebSocket } = await import("ws");
		const relay = await startRelayServer(0);
		try {
			const url = `ws://127.0.0.1:${relay.port}`;
			const makeBridge = () => {
				const v = fakeVault(new Map());
				const b = fakeBinaryStore();
				const store = new VaultSyncStore(b.store, v as never);
				const engine = new SyncEngine(
					store,
					new WebSocketConnectionFactory((u) => new WebSocket(u) as never),
					url,
				);
				return { v, engine };
			};
			const a = makeBridge();
			const bInstance = makeBridge();

			// A creates a note.
			a.v.notes.set("hello.md", "hello from A");
			a.v.files.set("hello.md", { path: "hello.md", stat: { mtime: 300 } });

			await a.engine.syncOnce(); // A → hub (imports md text into doc)
			await bInstance.engine.syncOnce(); // B ← hub (creates md file)
			expect(bInstance.v.notes.get("hello.md")).toBe("hello from A");

			// B edits its copy; A should receive it.
			bInstance.v.notes.set("hello.md", "hello from A — edited by B");
			bInstance.v.files.get("hello.md")!.stat.mtime = 400;

			await bInstance.engine.syncOnce(); // B → hub
			await a.engine.syncOnce(); // A ← hub
			expect(a.v.notes.get("hello.md")).toBe("hello from A — edited by B");
		} finally {
			await relay.close();
		}
	});
});
