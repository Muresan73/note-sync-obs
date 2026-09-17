// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from "vitest";
import { VaultSyncStore } from "../src/main";
import { VaultBinaryStore } from "../src/persistence/VaultBinaryStore";
import { initSyncAutomerge, encodeNoteDoc, decodeNoteDoc, applyEdit } from "../src/sync/SyncEngine";
import { startRelayServer } from "../src/sync/relayServer";
import { SyncEngine } from "../src/sync/SyncEngine";
import { WebSocketConnectionFactory } from "../src/sync/WebSocketTransport";
import { WebSocket } from "ws";

/**
 * Deletion & move semantics for the vault bridge:
 * - deleting a .md marks the doc as a tombstone (deleted: true)
 * - the tombstone propagates through the hub
 * - other vaults honor it by trashing the file (no resurrection)
 * - moving/renaming a note = create new + delete old (both propagate)
 */

beforeAll(async () => {
	await initSyncAutomerge();
});

type FakeFile = { path: string; stat: { mtime: number } };

function fakeVault(notes: Map<string, string>) {
	const files = new Map<string, FakeFile>();
	for (const p of notes.keys()) files.set(p, { path: p, stat: { mtime: 100 } });
	const trashed: string[] = [];
	return {
		files,
		notes,
		trashed,
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
			files.get(file.path)!.stat.mtime = Date.now();
		},
		async create(path: string, data: string) {
			const f = { path, stat: { mtime: Date.now() } };
			files.set(path, f);
			notes.set(path, data);
			return f as never;
		},
		async delete(path: string) {
			files.delete(path);
			notes.delete(path);
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
		list: vi.fn(async (dir: string) => ({
			files: [...blobs.keys()].filter((k) => k.startsWith(dir + "/")),
		})),
	};
	return { adapter, blobs, store: new VaultBinaryStore(adapter as never) };
}

function makeStore(notes?: Map<string, string>) {
	const vault = fakeVault(notes ?? new Map([["note.md", "original text"]]));
	const binary = fakeBinaryStore();
	const trashed = vi.fn(async (file: { path: string }) => {
		await vault.delete(file.path);
	});
	const store = new VaultSyncStore(binary.store, vault as never, trashed);
	return { vault, binary, store, trashed };
}

describe("deletion & move semantics", () => {
	it("marks the doc as deleted when the note file is removed, and trashes nothing locally", async () => {
		const { vault, store } = makeStore();
		await store.writeDoc("note.md", encodeNoteDoc({ path: "note.md", content: "original text", updatedAt: 100, deleted: false }));

		// User deletes the note.
		vault.files.delete("note.md");
		vault.notes.delete("note.md");

		// The doc path appears in listFiles (tombstone candidate) and readDoc
		// marks it deleted.
		const paths = await store.listFiles();
		expect(paths).toContain("note.md");
		const bytes = await store.readDoc("note.md");
		expect(decodeNoteDoc(bytes!).deleted).toBe(true);
	});

	it("honors an incoming tombstone by trashing the local file (no resurrection)", async () => {
		const { vault, store, trashed } = makeStore();
		vault.files.set("doomed.md", { path: "doomed.md", stat: { mtime: 1 } });
		vault.notes.set("doomed.md", "to be removed");

		const tombstone = applyEdit(
			encodeNoteDoc({ path: "doomed.md", content: "to be removed", updatedAt: 1 }),
			(d) => {
				d.deleted = true;
				d.content = "";
			},
		);
		await store.writeDoc("doomed.md", tombstone);

		expect(trashed).toHaveBeenCalledOnce();
		expect(vault.files.has("doomed.md")).toBe(false);
		expect(vault.notes.has("doomed.md")).toBe(false);
	});

	it("end-to-end: deletion in vault A removes the note in vault B via the hub", async () => {
		const relay = await startRelayServer(0);
		try {
			const url = `ws://127.0.0.1:${relay.port}`;
			const makeBridge = () => {
				const v = fakeVault(new Map());
				const b = fakeBinaryStore();
				const trashed = vi.fn(async (file: { path: string }) => {
					await v.delete(file.path);
				});
				const store = new VaultSyncStore(b.store, v as never, trashed);
				const engine = new SyncEngine(
					store,
					new WebSocketConnectionFactory((u) => new WebSocket(u) as never),
					url,
				);
				return { v, engine };
			};
			const a = makeBridge();
			const b = makeBridge();

			// Both have the note.
			a.v.notes.set("temp.md", "short-lived note");
			a.v.files.set("temp.md", { path: "temp.md", stat: { mtime: 300 } });
			await a.engine.syncOnce();
			await b.engine.syncOnce();
			expect(b.v.notes.get("temp.md")).toBe("short-lived note");

			// A deletes it.
			a.v.files.delete("temp.md");
			a.v.notes.delete("temp.md");

			await a.engine.syncOnce(); // propagate tombstone to hub
			await b.engine.syncOnce(); // B honors it
			expect(b.v.notes.has("temp.md")).toBe(false);
			expect(b.v.files.has("temp.md")).toBe(false);

			// And it does NOT resurrect on further rounds.
			await b.engine.syncOnce();
			await a.engine.syncOnce();
			expect(b.v.notes.has("temp.md")).toBe(false);
		} finally {
			await relay.close();
		}
	});

	it("a move/rename (new file + old deleted) lands as rename on the other vault", async () => {
		const relay = await startRelayServer(0);
		try {
			const url = `ws://127.0.0.1:${relay.port}`;
			const makeBridge = () => {
				const v = fakeVault(new Map());
				const b = fakeBinaryStore();
				const trashed = vi.fn(async (file: { path: string }) => {
					await v.delete(file.path);
				});
				const store = new VaultSyncStore(b.store, v as never, trashed);
				const engine = new SyncEngine(
					store,
					new WebSocketConnectionFactory((u) => new WebSocket(u) as never),
					url,
				);
				return { v, engine };
			};
			const a = makeBridge();
			const b = makeBridge();

			a.v.notes.set("old-name.md", "the content");
			a.v.files.set("old-name.md", { path: "old-name.md", stat: { mtime: 300 } });
			await a.engine.syncOnce();
			await b.engine.syncOnce();
			expect(b.v.notes.get("old-name.md")).toBe("the content");

			// A renames: create new file with same content, delete old.
			a.v.notes.set("new-name.md", "the content");
			a.v.files.set("new-name.md", { path: "new-name.md", stat: { mtime: 500 } });
			a.v.files.delete("old-name.md");
			a.v.notes.delete("old-name.md");

			await a.engine.syncOnce();
			await b.engine.syncOnce();

			// B now has the new name with the content and not the old one.
			expect(b.v.notes.get("new-name.md")).toBe("the content");
			expect(b.v.notes.has("old-name.md")).toBe(false);
		} finally {
			await relay.close();
		}
	});

	it("a live note with content is never exported over a tombstone (delete wins over stale create)", async () => {
		// Scenario: B never saw the note; A created then deleted it. The hub
		// holds the tombstone; B must not create the file.
		const { vault, store, trashed } = makeStore(new Map());
		const tombstone = applyEdit(
			encodeNoteDoc({ path: "ghost.md", content: "once existed", updatedAt: 1 }),
			(d) => {
				d.deleted = true;
				d.content = "";
			},
		);
		await store.writeDoc("ghost.md", tombstone);
		expect(vault.notes.has("ghost.md")).toBe(false);
		expect(trashed).not.toHaveBeenCalled(); // nothing to trash locally
	});
});
