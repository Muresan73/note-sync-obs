/**
 * Plugin entry point. Wires the vault to the sync loop and nothing else.
 */
import {
	Notice,
	Plugin,
	type App,
	type PluginManifest,
	type TAbstractFile,
} from 'obsidian';
import { initAutomerge, syncRound, wire, type Round } from './sync';
import { vaultStore, ensureDocDir, type VaultIO } from './vault';
import { listen, type Listener } from './server';
import { Settings, type Config } from './settings';

const DEFAULT: Config = {
	sync: true,
	intervalMs: 30_000,
	listen: false,
	port: 8521,
	peers: [],
};

/** Merge saved settings over the defaults, ignoring anything malformed. A
 *  hand-edited or truncated data.json must not be able to break the plugin. */
function loadConfig(saved: unknown): Config {
	const raw = (saved ?? {}) as Partial<Config>;
	const ms = raw.intervalMs;
	const port = raw.port;
	return {
		sync: typeof raw.sync === 'boolean' ? raw.sync : DEFAULT.sync,
		intervalMs:
			typeof ms === 'number' && ms >= 5_000 ? ms : DEFAULT.intervalMs,
		listen: typeof raw.listen === 'boolean' ? raw.listen : DEFAULT.listen,
		port:
			typeof port === 'number' && port > 0 && port < 65_536
				? Math.floor(port)
				: DEFAULT.port,
		peers: Array.isArray(raw.peers)
			? raw.peers.filter((p) => typeof p === 'string' && p)
			: [],
	};
}

export default class AutomergeSyncPlugin extends Plugin {
	config: Config = { ...DEFAULT };
	private store = vaultStore(this.bridge());
	private listener: Listener | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private statusBar: HTMLElement | null = null;
	private lastPaint = '';

	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
	}

	/** The vault, plus trashing. Obsidian has no vault-level delete; routing
	 *  through fileManager respects the user's trash settings. */
	private bridge(): VaultIO {
		const app = this.app;
		return Object.assign(Object.create(app.vault), {
			trash: (file: TAbstractFile) => app.fileManager.trashFile(file),
		});
	}

	async onload(): Promise<void> {
		await initAutomerge();
		this.config = loadConfig(await this.loadData());
		await ensureDocDir(this.app.vault.adapter);

		this.addSettingTab(new Settings(this.app, this));
		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: () => void this.syncNow(),
		});

		this.statusBar = this.addStatusBarItem();
		void this.restart();
	}

	onunload(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		void this.listener?.close();
		this.listener = null;
	}

	/** Sync every peer, then schedule the next round. Backoff doubles on
	 *  failure so an unplugged peer is retried politely, not in a hot loop. */
	// 	private async run(): Promise<void> {
	// 		if (!this.config.sync) {
	// 			this.editStatusBarText('automerge: off');
	// 			return;
	// 		}
	//
	// 		const rounds = await Promise.all(
	// 			this.config.peers.map((address) => this.syncOne(address)),
	// 		);
	// 		const failed = rounds.filter((r) => !r.ok);
	// 		const files = rounds.reduce((n, r) => n + r.files, 0);
	//
	// 		this.editStatusBarText(
	// 			failed.length
	// 				? `automerge: ${failed.length}/${rounds.length} peers failed — ${failed[0].error}`
	// 				: `automerge: ${files} files`,
	// 		);
	//
	// 		const delay = failed.length
	// 			? Math.min(this.config.intervalMs * 2, 300_000)
	// 			: this.config.intervalMs;
	// 		this.timer = setTimeout(() => void this.run(), delay);
	// 	}

	/** Open a socket to one peer and exchange documents over it. */
	private syncOne(address: string): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(address);

			ws.onopen = () => new Notice('happy its connected');

			ws.binaryType = 'arraybuffer';
			ws.onmessage = (e: Event) => {
				const message = new Uint8Array((e as MessageEvent).data);
			};

			ws.onclose = resolve;
			ws.onerror = reject;

			// const round = await syncRound(this.store, ws);
		});
	}

	async syncNow(): Promise<void> {
		if (!this.config.peers.length) {
			new Notice(
				'No peers configured. Add one in Settings → Automerge Sync.',
			);
			return;
		}
		const rounds = await Promise.all(
			this.config.peers.map(async (a) => this.syncOne(a)),
		);
		const files = rounds.reduce((n, r) => n + r.files, 0);
		const failed = rounds.filter((r) => !r.ok);
		new Notice(
			failed.length
				? `Synced ${files} files; ${failed.length} peer(s) failed: ${failed[0].error}`
				: `Synced ${files} files with ${this.config.peers.length} peer(s).`,
		);
	}

	/** Apply settings: restart the listener and the sync loop. */
	async restart(): Promise<void> {
		// TODO nothing to restart yet but maybe later
	}

	/**
	 * **Update the Status Bar Text**
	 *
	 * > These lines are needed to avoid redundant DOM updates
	 * > when the text hasn't changed, and to keep the last value
	 * > in sync so the check works on the next call.
	 */
	private editStatusBarText(text: string): void {
		if (text === this.lastPaint) return;
		this.lastPaint = text;
		this.statusBar?.setText(text);
	}
}
