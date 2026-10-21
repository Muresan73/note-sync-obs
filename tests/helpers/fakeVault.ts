/**
 * An in-memory vault, good enough to test the real bridge. Assertions are made
 * against files, never against document bytes — a test that only checks `.amrg`
 * blobs proves nothing about what the user sees.
 */
import { TFile, type TAbstractFile } from "obsidian";
import type { VaultIO } from "../../src/vault";

export type FakeFile = { text: string; bytes: Uint8Array; mtime: number };

export function fakeVault(seed: Record<string, FakeFile> = {}) {
	const files = new Map<string, FakeFile>(Object.entries(seed));
	const trashed: string[] = [];
	const created: string[] = [];

	const v = {
		adapter: {
			exists: async (p: string) => files.has(p),
			readBinary: async (p: string) => {
				const f = files.get(p);
				if (!f) throw new Error(`no such file: ${p}`);
				return f.bytes.slice().buffer;
			},
			writeBinary: async (p: string, data: ArrayBuffer) => {
				files.set(p, {
					text: "",
					bytes: new Uint8Array(data),
					// Docs are written constantly; they must never look like a
					// user edit or notes would re-import on every round.
					mtime: 0,
				});
			},
			mkdir: async () => {},
			list: async (dir: string) => ({
				files: [...files.keys()]
					.filter((p) => p.startsWith(`${dir}/`))
					.map((p) => p.slice(dir.length + 1)),
			}),
		},

		getFiles: () =>
			[...files.keys()]
				.filter((p) => !p.startsWith(".automerge-sync/"))
				.map((p) => tfile(p, files.get(p)!)),

		getAbstractFileByPath: (p: string) => {
			const f = files.get(p);
			return f ? tfile(p, f) : null;
		},

		read: async (f: TFile) => files.get(f.path)!.text,
		modify: async (f: TFile, data: string) => {
			const cur = files.get(f.path)!;
			files.set(f.path, { ...cur, text: data, mtime: cur.mtime + 1 });
		},
		create: async (p: string, data: string) => {
			created.push(p);
			files.set(p, { text: data, bytes: new TextEncoder().encode(data), mtime: 1 });
			return tfile(p, files.get(p)!);
		},
		trash: async (f: TAbstractFile) => {
			trashed.push(f.path);
			files.delete(f.path);
		},
	};

	/** Edit a file the way a user would: new text, newer mtime. */
	const editNote = (p: string, text: string) => {
		const cur = files.get(p)!;
		files.set(p, { ...cur, text, mtime: cur.mtime + 100 });
	};

	const editBinary = (p: string, bytes: Uint8Array) => {
		const cur = files.get(p)!;
		files.set(p, { ...cur, bytes, mtime: cur.mtime + 100 });
	};

	const addNote = (p: string, text: string) =>
		files.set(p, { text, bytes: new TextEncoder().encode(text), mtime: 1 });

	const addBinary = (p: string, bytes: Uint8Array) =>
		files.set(p, { text: "", bytes, mtime: 1 });

	const text = (p: string) => files.get(p)?.text;
	const bytes = (p: string) => files.get(p)?.bytes;

	return { io: v as unknown as VaultIO, files, trashed, created, editNote, editBinary, addNote, addBinary, text, bytes };
}

function tfile(path: string, f: FakeFile): TFile {
	const file = new TFile();
	file.path = path;
	file.name = path.split("/").pop()!;
	file.extension = path.includes(".") ? path.split(".").pop()! : "";
	file.stat = { mtime: f.mtime, ctime: f.mtime, size: f.bytes.length };
	return file;
}

/** Bytes that will not survive a lossy string conversion. */
export const pngBytes = (seed: number): Uint8Array => {
	const out = new Uint8Array(64);
	for (let i = 0; i < out.length; i++) out[i] = (i * 31 + seed) % 256;
	return out;
};