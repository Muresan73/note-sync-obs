import { Plugin, Notice, normalizePath, TFile, TAbstractFile, type PluginManifest, type App } from "obsidian";
import { VaultBinaryStore } from "./persistence/VaultBinaryStore";
import {
	AutomergeDocumentStore,
	AutomergeError,
	initAutomerge,
	type SampleDocument,
} from "./automerge/AutomergeDocumentStore";
import { createOrUpdateSample, SAMPLE_PATH } from "./commands/sampleDocument";
import { DocumentModal } from "./ui/DocumentView";
import { SyncSettingTab, DEFAULT_SETTINGS, type SyncSettings } from "./ui/SyncSettingTab";
import { StatusBarIndicator } from "./ui/StatusBarIndicator";
import {
	SyncEngine,
	startBackgroundSync,
	initSyncAutomerge,
	applyEdit,
	decodeNoteDoc,
	encodeNoteDoc,
	type SyncStore,
	type SyncStatus,
	type PeerConnectionFactory,
} from "./sync/SyncEngine";

const DOC_DIR = ".automerge-sync";
const DOC_EXTENSION = ".amrg"; // automerge-encoded note docs, distinct from source notes

/**
 * SyncStore over the Obsidian vault — the bridge between note text and
 * Automerge documents:
 *
 * - `listFiles`: all markdown notes in the vault
 * - `readDoc`: load the note's automerge doc, first importing the CURRENT
 *   markdown text if it changed on disk since the last sync (mtime check)
 * - `writeDoc`: persist the merged doc AND write its content back to the
 *   .md file if the merged text differs from disk
 *
 * This is what makes sync actually move note content between vaults.
 */
export class VaultSyncStore implements SyncStore {
	constructor(
		private readonly adapter: VaultBinaryStore,
		private readonly vault: {
			getMarkdownFiles(): TFile[];
			getAbstractFileByPath(path: string): TAbstractFile | null;
			read(file: TFile): Promise<string>;
			modify(file: TFile, data: string): Promise<void>;
			create(path: string, data: string): Promise<TFile>;
		},
	) {}

	private docPathFor(notePath: string): string {
		// Flatten the path so no directory structure is needed; encode to keep
		// it a safe single filename.
		const safe = notePath.replace(/[^a-zA-Z0-9._-]/g, "_");
		return `${DOC_DIR}/${safe}${DOC_EXTENSION}`;
	}

	async listFiles(): Promise<string[]> {
		return this.vault.getMarkdownFiles().map((f) => f.path);
	}

	async readDoc(notePath: string): Promise<Uint8Array | null> {
		const p = this.docPathFor(notePath);
		const abstract = this.vault.getAbstractFileByPath(notePath);
		const file: TFile | null = abstract && "stat" in abstract ? (abstract as TFile) : null;

		if (!(await this.adapter.exists(p))) {
			// No doc yet: seed it FROM the markdown text (with mtime) so the
			// first sync round carries the note's content. Without this, a
			// brand-new note syncs as an empty doc and its text never travels.
			if (file) {
				const text = await this.vault.read(file);
				return encodeNoteDoc({
					path: notePath,
					content: text,
					updatedAt: file.stat.mtime,
				});
			}
			return null;
		}
		const bytes = await this.adapter.read(p);

		// Import: if the .md file changed since we last stored the doc,
		// fold the current text into the doc as a new change.
		try {
			const doc = decodeNoteDoc(bytes);
			const abstract = this.vault.getAbstractFileByPath(notePath);
			const file: TFile | null = abstract && "stat" in abstract ? (abstract as TFile) : null;
			if (file && typeof file.stat.mtime === "number") {
				// doc.updatedAt holds the mtime of the last imported text.
				if (file.stat.mtime > doc.updatedAt) {
					const text = await this.vault.read(file);
					const mtime = file.stat.mtime;
					return applyEdit(bytes, (d) => {
						d.content = text;
						d.updatedAt = mtime;
					});
				}
			}
		} catch {
			// Corrupt doc — fall through and return raw bytes; sync will surface
			// the error if the bytes are unreadable by automerge itself.
		}
		return bytes;
	}

	async writeDoc(notePath: string, bytes: Uint8Array): Promise<void> {
		await this.adapter.write(this.docPathFor(notePath), bytes);

		// Export: if the merged doc's content differs from the .md on disk,
		// write it back so sync results are visible in the vault.
		const abstract = this.vault.getAbstractFileByPath(notePath);
		const doc = decodeNoteDoc(bytes);
		if (abstract && "stat" in abstract) {
			const file = abstract as TFile;
			const diskText = await this.vault.read(file);
			if (diskText !== doc.content) {
				await this.vault.modify(file, doc.content);
			}
		} else if (doc.content) {
			// Note exists on the remote but not here — create it.
			await this.vault.create(normalizePath(notePath), doc.content);
		}
	}
}

export default class AutomergeSyncPlugin extends Plugin {
	settings: SyncSettings = { ...DEFAULT_SETTINGS };
	private binaryStore!: VaultBinaryStore;
	private store!: AutomergeDocumentStore;
	private syncEngine: SyncEngine | null = null;
	private cancelSync: (() => void) | null = null;
	private statusBar!: StatusBarIndicator;

	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
	}

	/** Exposed for tests. */
	get engine(): SyncEngine | null {
		return this.syncEngine;
	}

	async onload(): Promise<void> {
		await initAutomerge();
		await initSyncAutomerge();
		await this.loadSettings();

		this.binaryStore = new VaultBinaryStore(this.app.vault.adapter);
		await this.binaryStore.mkdirp(DOC_DIR);
		this.store = new AutomergeDocumentStore(this.binaryStore, SAMPLE_PATH);

		this.statusBar = new StatusBarIndicator(() =>
			this.addStatusBarItem(),
		);
		this.statusBar.attach();

		this.addSettingTab(new SyncSettingTab(this.app, this));

		this.registerCommands();
		await this.restartSync();
	}

	onunload(): void {
		this.cancelSync?.();
		this.statusBar.detach();
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<SyncSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** (Re)start or stop background sync based on current settings. */
	async restartSync(): Promise<void> {
		this.cancelSync?.();
		this.cancelSync = null;
		this.syncEngine = null;

		if (!this.settings.syncEnabled) {
			this.statusBar.update({
				state: "offline",
				lastSyncMs: null,
				filesSynced: 0,
				error: null,
				peers: 0,
			});
			return;
		}

		const syncStore = new VaultSyncStore(this.binaryStore, this.app.vault);
		const factory: PeerConnectionFactory = {
			connect: async (url) => {
				const { WebSocketConnectionFactory } = await import("./sync/WebSocketTransport");
				return new WebSocketConnectionFactory((u) => new WebSocket(u)).connect(url);
			},
		};
		const engine = new SyncEngine(syncStore, factory, this.settings.serverUrl);
		engine.onStatus((s) => this.statusBar.update(s));
		this.syncEngine = engine;
		this.cancelSync = startBackgroundSync(
			engine,
			this.settings.syncIntervalMs,
			(e) => console.error("[automerge-sync] background sync error:", e),
		);
	}

	private registerCommands(): void {
		this.addCommand({
			id: "create-or-update-sample",
			name: "Create or update Automerge sample document",
			callback: async () => {
				try {
					const doc = await createOrUpdateSample(this.store, this);
					new Notice(`Automerge sample document saved (${doc.tags.length} tags).`);
				} catch (e) {
					this.reportFailure("Failed to create/update sample document", e);
				}
			},
		});

		this.addCommand({
			id: "show-sample",
			name: "Show Automerge sample document",
			callback: async () => {
				try {
					const doc: SampleDocument = await this.store.load();
					new DocumentModal(this.app, doc).open();
				} catch (e) {
					this.reportFailure("Failed to load sample document", e);
				}
			},
		});

		this.addCommand({
			id: "inspect-bytes",
			name: "Show raw Automerge byte length",
			callback: async () => {
				try {
					const bytes = await this.app.vault.adapter.readBinary(SAMPLE_PATH);
					new Notice(`sample.automerge is ${bytes.byteLength} bytes.`);
				} catch (e) {
					this.reportFailure("Failed to read document bytes", e);
				}
			},
		});

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: async () => {
				if (!this.syncEngine) {
					new Notice("Sync is disabled in settings.");
					return;
				}
				const status: SyncStatus = await this.syncEngine.syncOnce();
				if (status.state === "synced") {
					new Notice(`Synced ${status.filesSynced} files.`);
				} else {
					new Notice(`Sync failed: ${status.error ?? status.state}`);
				}
			},
		});
	}

	private reportFailure(message: string, error: unknown): void {
		new Notice(`${message}: ${error instanceof Error ? error.message : String(error)}`);
		if (error instanceof AutomergeError && error.cause) {
			console.error("[automerge-sync] underlying cause:", error.cause);
		} else {
			console.error("[automerge-sync]", error);
		}
	}
}

// Re-export for tests convenience.
export { decodeNoteDoc, normalizePath };
