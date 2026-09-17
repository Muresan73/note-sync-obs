/**
 * Sync engine — the pure, Obsidian-free core.
 *
 * Model: every vault note becomes one Automerge document keyed by a stable
 * file path. Two replicas (local store, remote peer) exchange Automerge sync
 * messages until both reach the same heads; the merged result is written back
 * to each side's storage. This module knows nothing about Obsidian or
 * WebSockets — it works on a `SyncStore` (path → bytes) and a `Transport`
 * (async send/receive of binary frames).
 */

import * as Automerge from "@automerge/automerge/slim";
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64";
import type { Doc, SyncState } from "@automerge/automerge/slim";

export type SyncStateName = "idle" | "connecting" | "syncing" | "synced" | "error" | "offline";

export interface SyncStatus {
	state: SyncStateName;
	lastSyncMs: number | null; // epoch ms of last successful sync, null if never
	filesSynced: number;
	error: string | null;
	peers: number;
}

export interface SyncStore {
	/** All file paths this replica tracks (the vault's markdown notes). */
	listFiles(): Promise<string[]>;
	/** Read the Automerge bytes for a path, or null if we have no doc yet. */
	readDoc(path: string): Promise<Uint8Array | null>;
	/** Persist merged Automerge bytes for a path. */
	writeDoc(path: string, bytes: Uint8Array): Promise<void>;
}

export interface Transport {
	/** Send one binary frame to the peer. */
	send(frame: Uint8Array): Promise<void>;
	/** Receive the next frame; resolves null if the connection closed. */
	receive(): Promise<Uint8Array | null>;
	/** True if the transport believes the peer is reachable. */
	isOpen(): boolean;
	close(): Promise<void>;
}

export interface PeerConnectionFactory {
	/** Open a fresh bidirectional connection to the configured URL. */
	connect(url: string): Promise<Transport>;
}

// ---------- Automerge init (single global) ----------

let initPromise: Promise<void> | null = null;
export async function initSyncAutomerge(): Promise<void> {
	if (!initPromise) {
		initPromise = Automerge.initializeBase64Wasm(automergeWasmBase64);
	}
	await initPromise;
}

// ---------- Document codecs ----------

/** The payload stored inside each Automerge doc: the note content + metadata. */
export interface NotePayload {
	path: string;
	content: string;
	updatedAt: number;
}

export function encodeNoteDoc(payload: NotePayload): Uint8Array {
	return Automerge.save(Automerge.from(payload as unknown as Record<string, never>));
}

export function decodeNoteDoc(bytes: Uint8Array): NotePayload {
	return Automerge.load<NotePayload>(bytes) as unknown as NotePayload;
}

/**
 * Apply a mutation to an encoded doc while preserving its history, so two
 * replicas edited this way can genuinely CRDT-merge afterwards.
 */
export function applyEdit(
	bytes: Uint8Array,
	mutator: (draft: NotePayload) => void,
): Uint8Array {
	const doc = Automerge.load<NotePayload>(bytes) as unknown as Doc<NotePayload>;
	const next = Automerge.change(doc, "edit", mutator as never);
	return Automerge.save(next);
}

// ---------- The engine ----------

export class SyncEngine {
	private status: SyncStatus = {
		state: "offline",
		lastSyncMs: null,
		filesSynced: 0,
		error: null,
		peers: 0,
	};
	private statusListeners = new Set<(s: SyncStatus) => void>();
	private stopped = false;

	constructor(
		private readonly store: SyncStore,
		private readonly factory: PeerConnectionFactory,
		private readonly url: string,
	) {}

	getStatus(): SyncStatus {
		return { ...this.status };
	}

	onStatus(listener: (s: SyncStatus) => void): () => void {
		this.statusListeners.add(listener);
		return () => this.statusListeners.delete(listener);
	}

	private setState(patch: Partial<SyncStatus>): void {
		this.status = { ...this.status, ...patch };
		for (const l of this.statusListeners) l(this.getStatus());
	}

	stop(): void {
		this.stopped = true;
	}

	/**
	 * Run one full sync round against the remote. Bidirectional and
	 * converging: for every file either side knows about, exchange Automerge
	 * sync messages until heads match, then write merged bytes back to both.
	 * Files that exist only on one side are created on the other.
	 */
	async syncOnce(): Promise<SyncStatus> {
		if (this.stopped) return this.getStatus();
		this.setState({ state: "connecting", error: null });
		let transport: Transport;
		try {
			transport = await this.factory.connect(this.url);
		} catch (e) {
			this.setState({ state: "error", error: `connect failed: ${String(e)}` });
			return this.getStatus();
		}
		if (this.stopped) {
			await transport.close().catch(() => {});
			return this.getStatus();
		}

		try {
			this.setState({ state: "syncing" });
			const localFiles = new Set(await this.store.listFiles());
			// 1. Ask the peer for its file list.
			await transport.send(encodeFrame({ type: "file-list-request" }));
			const remoteListFrame = await withTimeout(transport.receive(), 15000, "file-list timeout");
			if (!remoteListFrame) throw new Error("peer closed during file list exchange");
			const remoteList = decodeFrame<FileListMsg>(remoteListFrame);
			if (remoteList.type !== "file-list") throw new Error(`unexpected frame ${remoteList.type}`);

			// 2. Union of paths — sync every file in either direction.
			const allPaths = [...new Set([...localFiles, ...remoteList.paths])];
			let synced = 0;

			for (const path of allPaths) {
				if (this.stopped) break;
				await this.syncOneFile(transport, path);
				synced++;
			}

			this.setState({
				state: "synced",
				lastSyncMs: Date.now(),
				filesSynced: synced,
				error: null,
				peers: 1,
			});
			return this.getStatus();
		} catch (e) {
			this.setState({ state: "error", error: String(e) });
			return this.getStatus();
		} finally {
			await transport.close().catch(() => {});
		}
	}

	/**
	 * Sync a single path: loop Automerge sync messages with the peer until
	 * both report done, then persist the merged doc locally.
	 */
	private async syncOneFile(transport: Transport, path: string): Promise<void> {
		await transport.send(encodeFrame({ type: "begin", path }));
		const localBytes = await this.store.readDoc(path);
		let doc: Doc<NotePayload> = localBytes
			? (Automerge.load(localBytes) as unknown as Doc<NotePayload>)
			: (Automerge.init<NotePayload>() as unknown as Doc<NotePayload>);
		let syncState: SyncState = Automerge.initSyncState();
		// IMPORTANT: a missing local file must start as an EMPTY doc with no
		// changes. Writing an init change here would create a concurrent
		// "content: ''" assignment that wins the LWW merge and clobbers the
		// peer's content. An empty doc contributes nothing; after the
		// handshake we only persist if the peer actually had content.

		let sentDone = false;
		for (let round = 0; round < 100; round++) {
			const [genState, message] = Automerge.generateSyncMessage(doc, syncState);
			syncState = genState;

			if (message) {
				await transport.send(encodeFrame({ type: "sync", path, message }));
			} else if (!sentDone) {
				sentDone = true; // nothing more to send → we consider ourselves in sync
				await transport.send(encodeFrame({ type: "done", path }));
			}

			const frame = await withTimeout(transport.receive(), 15000, `sync timeout for ${path}`);
			if (!frame) throw new Error(`peer closed during sync of ${path}`);
			const msg = decodeFrame<SyncMsg | DoneMsg>(frame);

			if (msg.type === "done") {
				if (sentDone) {
					// Both sides in sync: persist merged state locally, but only
					// if the merged doc actually has content (i.e. someone ever
					// wrote this file). An empty doc on both sides = file exists
					// nowhere; don't materialize it.
					const hasChanges = Automerge.getAllChanges(doc).length > 0;
					if (hasChanges) {
						await this.store.writeDoc(path, Automerge.save(doc));
					}
					return;
				}
				continue;
			}
			if (!("message" in msg)) throw new Error(`unexpected frame type: ${JSON.stringify(msg)}`);

			const [recvDoc, recvState] = Automerge.receiveSyncMessage(doc, syncState, msg.message);
			doc = recvDoc;
			syncState = recvState;
		}
		throw new Error(`sync did not converge for ${path}`);
	}
}

// ---------- Peer-side session handler ----------
//
// Runs on the *other* replica (a relay server that also keeps doc copies, or
// a second plugin instance in tests). Handles one initiator session: reads
// frames, applies automerge sync messages, replies, persists when in sync.

export async function handlePeerSession(transport: Transport, store: SyncStore): Promise<void> {
	let currentPath: string | null = null;
	let doc: Doc<NotePayload> | null = null;
	let syncState: SyncState | null = null;

	for (;;) {
		const frame = await transport.receive();
		if (!frame) return;
		const msg = decodeFrame<Frame>(frame);

		switch (msg.type) {
			case "file-list-request": {
				const paths = await store.listFiles();
				await transport.send(encodeFrame({ type: "file-list", paths }));
				break;
			}
			case "begin": {
				currentPath = msg.path;
				const bytes = await store.readDoc(msg.path);
				doc = bytes
					? (Automerge.load(bytes) as unknown as Doc<NotePayload>)
					: (Automerge.init<NotePayload>() as unknown as Doc<NotePayload>);
				syncState = Automerge.initSyncState();
				break;
			}
			case "sync": {
				if (msg.path !== currentPath || doc === null || syncState === null) {
					throw new Error(`sync message for unopened session (${msg.path} vs ${currentPath})`);
				}
				const currentDoc: Doc<NotePayload> = doc;
				const currentSyncState: SyncState = syncState;
				const [recvDoc, recvState] = Automerge.receiveSyncMessage(
					currentDoc,
					currentSyncState,
					msg.message,
				);
				doc = recvDoc;
				syncState = recvState;
				// Reply with our side of the automerge handshake, if any.
				const [, reply] = Automerge.generateSyncMessage(recvDoc, recvState);
				if (reply) {
					await transport.send(encodeFrame({ type: "sync", path: msg.path, message: reply }));
				} else {
					// In sync on our side: persist and confirm — but only if the
					// doc has changes (never materialize a file nobody wrote).
					if (Automerge.getAllChanges(recvDoc).length > 0) {
						await store.writeDoc(msg.path, Automerge.save(recvDoc));
					}
					await transport.send(encodeFrame({ type: "done", path: msg.path }));
				}
				break;
			}
			case "done":
				// Initiator believes we're in sync; ack so it can finish, then
				// persist our copy too.
				if (currentPath && doc) {
					if (Automerge.getAllChanges(doc).length > 0) {
						await store.writeDoc(currentPath, Automerge.save(doc));
					}
					await transport.send(encodeFrame({ type: "done", path: currentPath }));
				}
				break;
			default:
				break;
		}
	}
}

// ---------- Frame codec (small JSON header + binary payload) ----------

type BeginMsg = { type: "begin"; path: string };
type SyncMsg = { type: "sync"; path: string; message: Uint8Array };
type DoneMsg = { type: "done"; path: string };
type FileListMsg = { type: "file-list"; paths: string[] };
type FileListRequestMsg = { type: "file-list-request" };
export type Frame = BeginMsg | SyncMsg | DoneMsg | FileListMsg | FileListRequestMsg;

export function encodeFrame(frame: Frame): Uint8Array {
	// JSON header (base64 for the binary message field), length-prefixed.
	const header: Record<string, unknown> = { ...frame };
	if ("message" in header && header.message instanceof Uint8Array) {
		header.message = bytesToBase64(header.message as Uint8Array);
		header.hasBinary = true;
	}
	const json = JSON.stringify(header);
	const headerBytes = new TextEncoder().encode(json);
	const out = new Uint8Array(4 + headerBytes.length);
	new DataView(out.buffer).setUint32(0, headerBytes.length, false);
	out.set(headerBytes, 4);
	return out;
}

export function decodeFrame<T extends Frame>(bytes: Uint8Array): T {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const headerLen = view.getUint32(0, false);
	const json = new TextDecoder().decode(bytes.subarray(4, 4 + headerLen));
	const parsed = JSON.parse(json);
	if (parsed.hasBinary) {
		parsed.message = base64ToBytes(parsed.message);
		delete parsed.hasBinary;
	}
	return parsed as T;
}

// ---------- helpers ----------

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			p,
			new Promise<never>((_, rej) => {
				timer = setTimeout(() => rej(new Error(label)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Run syncOnce on an interval until cancelled. Returns a cancel function. */
export function startBackgroundSync(
	engine: SyncEngine,
	intervalMs: number,
	onError?: (e: unknown) => void,
): () => void {
	let cancelled = false;
	let running = false;
	const tick = async () => {
		if (cancelled || running) return;
		running = true;
		try {
			await engine.syncOnce();
		} catch (e) {
			onError?.(e);
		} finally {
			running = false;
		}
	};
	const timer = setInterval(tick, intervalMs);
	void tick();
	return () => {
		cancelled = true;
		clearInterval(timer);
	};
}
