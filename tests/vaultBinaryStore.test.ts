import { describe, it, expect, vi } from "vitest";
import { VaultBinaryStore, bytesEqual } from "../src/persistence/VaultBinaryStore";

/** In-memory fake of Obsidian's DataAdapter binary surface. */
function fakeAdapter() {
	const files = new Map<string, ArrayBuffer>();
	const dirs = new Set<string>();
	return {
		files,
		dirs,
		exists: vi.fn(async (p: string) => files.has(p) || dirs.has(p)),
		readBinary: vi.fn(async (p: string) => {
			const data = files.get(p);
			if (!data) throw new Error(`File not found: ${p}`);
			return data.slice(0);
		}),
		writeBinary: vi.fn(async (p: string, data: ArrayBuffer) => {
			if (dirs.has(p)) throw new Error(`Is a directory: ${p}`);
			files.set(p, data.slice(0));
		}),
		mkdir: vi.fn(async (p: string) => {
			dirs.add(p);
		}),
	};
}

describe("VaultBinaryStore", () => {
	it("writes and reads Uint8Array without UTF-8 corruption", async () => {
		const adapter = fakeAdapter();
		const store = new VaultBinaryStore(adapter);
		const bytes = new Uint8Array(256);
		for (let i = 0; i < 256; i++) bytes[i] = i; // all byte values incl. >0x7F
		await store.write("doc.automerge", bytes);
		const read = await store.read("doc.automerge");
		expect(bytesEqual(read, bytes)).toBe(true);
		// Never touched a string encoding path:
		expect(adapter.writeBinary).toHaveBeenCalledTimes(2); // tmp + final
	});

	it("creates missing parent directories with mkdirp", async () => {
		const adapter = fakeAdapter();
		const store = new VaultBinaryStore(adapter);
		await store.mkdirp(".automerge-sync/nested");
		expect(adapter.dirs.has(".automerge-sync")).toBe(true);
		expect(adapter.dirs.has(".automerge-sync/nested")).toBe(true);
	});

	it("throws a useful error for a missing file", async () => {
		const store = new VaultBinaryStore(fakeAdapter());
		await expect(store.read("nope.automerge")).rejects.toThrow(/File not found/);
	});

	it("propagates failed writes and leaves no partial final file", async () => {
		const adapter = fakeAdapter();
		// Make the tmp write fail by pre-creating a directory at tmp path.
		adapter.dirs.add("doc.automerge.tmp");
		const store = new VaultBinaryStore(adapter);
		await expect(store.write("doc.automerge", new Uint8Array([9, 9]))).rejects.toThrow(/Is a directory/);
		expect(adapter.files.has("doc.automerge")).toBe(false);
	});

	it("keeps original intact when tmp verification fails", async () => {
		const adapter = fakeAdapter();
		const original = new Uint8Array([1, 2, 3]);
		const store = new VaultBinaryStore(adapter);
		await store.write("doc.automerge", original);

		// Corrupt verification: make readBinary of tmp return wrong bytes.
		adapter.readBinary.mockImplementationOnce(async (p: string) => {
			if (p.endsWith(".tmp")) return new ArrayBuffer(0);
			const data = adapter.files.get(p);
			return data!.slice(0);
		});
		await expect(store.write("doc.automerge", new Uint8Array([7]))).rejects.toThrow(/verification failed/i);
		const untouched = await store.read("doc.automerge");
		expect(bytesEqual(untouched, original)).toBe(true);
	});
});
