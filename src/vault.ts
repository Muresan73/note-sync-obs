/**
 * The only file that knows Obsidian exists. Everything else deals in bytes
 * and paths.
 *
 * A note is a markdown file. Its CRDT document lives beside it in
 * `.automerge-sync/`. On every read we fold the current file into the
 * document; on every write we fold the merged document back out. That
 * two-way fold is the whole bridge — without it sync succeeds and the vault
 * never changes.
 *
 * Attachments are base64 inside their document (see Doc in sync.ts). They
 * are only folded in when the content hash changes, so an untouched image
 * costs one hash and no traffic.
 */
import { normalizePath, TFile, type TAbstractFile, type Vault } from "obsidian";
import * as Automerge from "@automerge/automerge/slim";
import { type Doc, type Store } from "./sync";

const DOC_DIR = ".automerge-sync";
const SUFFIX = ".amrg";

/** What the bridge needs from a vault. `Vault` satisfies this apart from
 *  trashing, which is not a vault method — Obsidian routes deletions through
 *  `fileManager.trashFile` so they respect the user's trash settings. */
export type VaultIO = Vault & { trash(file: TAbstractFile): Promise<void> };

const isNote = (p: string): boolean => p.endsWith(".md");

/** Flatten a vault path into one safe filename. The real path lives inside the
 *  document, so it is read back out of the doc rather than guessed from the
 *  filename — `_` is a legal character in a real filename, so the mapping is
 *  not reversible. */
const docPath = (p: string): string => `${DOC_DIR}/${p.replace(/[^a-zA-Z0-9._-]/g, "_")}${SUFFIX}`;

const readDocByName = async (adapter: VaultIO["adapter"], name: string): Promise<Automerge.Doc<Doc> | null> => {
	try {
		return Automerge.load<Doc>(new Uint8Array(await adapter.readBinary(`${DOC_DIR}/${name}`)));
	} catch {
		return null;
	}
};

const parentOf = (p: string): string => p.split("/").slice(0, -1).join("/");

/** Automerge, WebCrypto and Obsidian's adapter all want a Uint8Array sitting
 *  on a plain (non-shared, non-pooled) ArrayBuffer. Always hand them a copy. */
const plain = (data: Uint8Array): ArrayBuffer => Uint8Array.from(data).buffer;

const encode = (data: Uint8Array): string => btoa(String.fromCharCode(...Uint8Array.from(data)));

const decode = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", plain(bytes));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Create DOC_DIR if missing. */
export async function ensureDocDir(vault: VaultIO["adapter"]): Promise<void> {
	if (!(await vault.exists(DOC_DIR))) await vault.mkdir(DOC_DIR);
}

/**
 * Build a Store over a vault. This is the only place that knows the file
 * format on either side of the bridge.
 */
export function vaultStore(vault: VaultIO): Store {
	const fileAt = (path: string): TFile | null => {
		const found = vault.getAbstractFileByPath(path);
		return found instanceof TFile ? found : null;
	};

	/** Tombstoned paths whose file is gone, found by scanning the doc dir.
	 *  Cached for one round; list() is called once per round. */
	let ghosts: Set<string> | null = null;

	/** Read a document off disk, or null if it is missing or unreadable. */
	const loadStored = async (path: string): Promise<Automerge.Doc<Doc> | null> => {
		try {
			return Automerge.load<Doc>(new Uint8Array(await vault.adapter.readBinary(docPath(path))));
		} catch {
			return null;
		}
	};

	const findGhosts = async (): Promise<Set<string>> => {
		if (ghosts) return ghosts;
		const gone = new Set<string>();
		for (const name of (await vault.adapter.list(DOC_DIR)).files) {
			if (!name.endsWith(SUFFIX)) continue;
			// Read every doc; the one whose note is missing is a deletion that
			// has not been marked yet.
			const doc = await readDocByName(vault.adapter, name);
			if (doc && !doc.deleted && !fileAt(doc.path)) gone.add(doc.path);
		}
		return (ghosts = gone);
	};

	/** Fold a live file into its document, or start a new one from the file. */
	const importFile = async (file: TFile): Promise<Automerge.Doc<Doc>> => {
		const stored = await loadStored(file.path);

		if (!stored) {
			// First sight of this file. Seed from its current contents so the
			// text actually travels on the next round.
			if (isNote(file.path)) {
				return Automerge.from<Doc>({
					path: file.path,
					content: await vault.read(file),
					updatedAt: file.stat.mtime,
				});
			}
			const bytes = new Uint8Array(await vault.adapter.readBinary(file.path));
			return Automerge.from<Doc>({
				path: file.path,
				content: encode(bytes),
				updatedAt: file.stat.mtime,
				hash: await sha256(bytes),
			});
		}

		if (isNote(file.path)) {
			// The file is authoritative when it changed since we last read it.
			if (file.stat.mtime <= stored.updatedAt) return stored;
			const text = await vault.read(file);
			return Automerge.change(stored, "import", (d) => {
				d.content = text;
				d.updatedAt = file.stat.mtime;
			});
		}

		// Attachment: fold in only when the bytes actually differ.
		const bytes = new Uint8Array(await vault.adapter.readBinary(file.path));
		const hash = await sha256(bytes);
		if (hash === stored.hash) return stored;
		return Automerge.change(stored, "import", (d) => {
			d.content = encode(bytes);
			d.hash = hash;
			d.updatedAt = file.stat.mtime;
		});
	};

	/** Write a merged document back to the vault. */
	const exportDoc = async (path: string, doc: Doc): Promise<void> => {
		const file = fileAt(path);

		if (doc.deleted) {
			if (file) await vault.trash(file);
			return;
		}

		if (file && isNote(path)) {
			if ((await vault.read(file)) !== doc.content) await vault.modify(file, doc.content);
			return;
		}

		if (file) {
			// Only rewrite an attachment when its bytes differ from disk.
			const current = await vault.adapter
				.readBinary(file.path)
				.then((b) => new Uint8Array(b))
				.catch(() => null);
			if (!current || (await sha256(current)) !== doc.hash) {
				await vault.adapter.writeBinary(file.path, plain(decode(doc.content)));
			}
			return;
		}

		// The file exists only on the peer. Create it.
		const dir = parentOf(path);
		if (dir) await vault.adapter.mkdir(dir);
		const target = normalizePath(path);
		if (isNote(path)) await vault.create(target, doc.content);
		else await vault.adapter.writeBinary(target, plain(decode(doc.content)));
	};

	return {
		async list() {
			ghosts = null;
			const live = vault.getFiles().map((f) => f.path);
			return [...new Set([...live, ...(await findGhosts())])];
		},

		async read(path) {
			const file = fileAt(path);
			if (file) return Automerge.save(await importFile(file));

			// No file here. Either a deletion in flight, or a path that has
			// never existed in this vault — and for that an empty document is
			// correct, and must stay empty (see sync.ts).
			const stored = await loadStored(path);
			if (!stored) return null;
			if (stored.deleted) return Automerge.save(stored);

			// The file vanished but the deletion was never marked. Tombstone it
			// so the deletion travels instead of the file resurrecting.
			return Automerge.save(
				Automerge.change(stored, "delete", (d) => {
					d.deleted = true;
					d.content = "";
				}),
			);
		},

		async write(path, bytes) {
			await ensureDocDir(vault.adapter);
			await vault.adapter.writeBinary(docPath(path), plain(bytes));
			await exportDoc(path, Automerge.load<Doc>(bytes));
		},
	};
}