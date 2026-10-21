/**
 * The sync protocol. Pure — no Obsidian, no sockets, no timers.
 *
 * Every note is one Automerge document. A round is: ask the peer for its file
 * list, then for each path in either vault exchange Automerge sync messages
 * until both sides report done. The CRDT does the merging; this file only moves
 * bytes.
 */
import * as Automerge from '@automerge/automerge/slim';
import { automergeWasmBase64 } from '@automerge/automerge/automerge.wasm.base64';
import type { SyncMessage, SyncState } from '@automerge/automerge';

let started: Promise<void> | null = null;

/** Load the Automerge WASM blob. Safe to call repeatedly; happens once. */
export function initAutomerge(): Promise<void> {
	return (started ??= Automerge.initializeBase64Wasm(automergeWasmBase64));
}

/** What we store per path. A `type`, not an `interface`: Automerge needs the
 *  implicit index signature that only a type alias provides.
 *
 *  `content` is always a string — markdown text for a note, base64 for an
 *  attachment. Automerge cannot hold a Uint8Array: it turns one into a CRDT
 *  map of index keys and the bytes come back as an object. Base64 round-trips
 *  exactly and keeps the merge behaviour uniform. */
export type Doc = {
	path: string;
	content: string;
	updatedAt: number;
	hash: string;
	deleted: boolean;
};

/** Where documents come from and go to. `vault.ts` implements this. */
export interface Store {
	list(): Promise<string[]>;
	read(path: string): Promise<Uint8Array | null>;
	write(path: string, bytes: Uint8Array): Promise<void>;
}


// export const bytesToBgse64 = (b: Uint8Array): string =>
// 	btoa(String.fromCharCode(...b));

export const base64ToBytes = (s: string): Uint8Array =>
	Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Frames are a JSON header with a length prefix, so a reader knows how much to read. */
type Frame =
	| { t: 'files' }
	| { t: 'files.reply'; paths: string[] }
	| { t: 'open'; path: string }
	| { t: 'sync'; path: string; m: string }
	| { t: 'done'; path: string };

const encodeFrame = (f: Frame): Uint8Array => {
	const header = new TextEncoder().encode(JSON.stringify(f));
	const out = new Uint8Array(4 + header.length);
	new DataView(out.buffer).setUint32(0, header.length, false);
	out.set(header, 4);
	return out;
};

const decodeFrame = (bytes: Uint8Array): Frame => {
	const len = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	).getUint32(0, false);
	return JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len)));
};

/** Load a stored document, or an empty one if we have never seen the path.
 *  An empty doc must stay empty: writing an init change here would create a
 *  concurrent `content: ""` that wins the merge and erases the peer's text. */
const loadDoc = (bytes: Uint8Array | null): Automerge.Doc<Doc> =>
	bytes ? Automerge.load<Doc>(bytes) : Automerge.init<Doc>();

const saveDoc = (doc: Automerge.Doc<Doc>): Uint8Array => Automerge.save(doc);

/** An Automerge doc with no changes has nothing worth writing to disk. */
const hasContent = (doc: Automerge.Doc<Doc>): boolean =>
	Automerge.getAllChanges(doc).length > 0;


export type Round =
	{ ok: true; files: number } | { ok: false; files: number; error: string };

/** Read one frame, or fail loudly if the socket died. A truncated read must
 *  never be mistaken for a valid frame. */
async function recvFrame(peer: Wire, label: string): Promise<Frame> {
	const bytes = await withTimeout(peer.recv(), 15000, label);
	if (!bytes) throw new Error('peer closed the connection');
	return decodeFrame(bytes);
}

/**
 * Sync one direction: push everything we have to `peer`, and accept everything
 * it sends back. Never throws — a dead peer is a result, not an exception.
 */
export async function syncRound(store: Store, peer: Wire): Promise<Round> {
	let files = 0;
	try {
		await peer.send(encodeFrame({ t: 'files' }));
		const reply = await recvFrame(
			peer,
			'peer did not answer the file list',
		);
		if (reply.t !== 'files.reply')
			throw new Error(`expected a file list, got ${reply.t}`);

		for (const path of new Set([...(await store.list()), ...reply.paths])) {
			await syncPath(store, peer, path);
			files++;
		}
		return { ok: true, files };
	} catch (e) {
		return {
			ok: false,
			files,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

/** Exchange sync messages for one path until both sides are in sync. */
async function syncPath(store: Store, peer: Wire, path: string): Promise<void> {
	await peer.send(encodeFrame({ t: 'open', path }));

	let doc = loadDoc(await store.read(path));
	let state: SyncState = Automerge.initSyncState();
	let iSaidDone = false;

	for (let round = 0; round < 100; round++) {
		const [next, message] = Automerge.generateSyncMessage(doc, state);
		state = next;

		if (message) {
			await peer.send(
				encodeFrame({ t: 'sync', path, m: bytesToBase64(message) }),
			);
		} else if (!iSaidDone) {
			// Nothing left to send. Announce it, then wait for the peer to agree.
			iSaidDone = true;
			await peer.send(encodeFrame({ t: 'done', path }));
		}

		const frame = await recvFrame(
			peer,
			`peer stopped responding while syncing ${path}`,
		);

		if (frame.t === 'done') {
			if (!iSaidDone) continue; // the peer finished first; let it have the last word
			// Both sides agree. Keep the merged result only if it holds anything.
			if (hasContent(doc)) await store.write(path, saveDoc(doc));
			return;
		}
		if (frame.t !== 'sync') throw new Error(`unexpected frame ${frame.t}`);
		if (frame.path !== path)
			throw new Error(`peer switched to ${frame.path} mid-file`);

		[doc, state] = Automerge.receiveSyncMessage(
			doc,
			state,
			base64ToBytes(frame.m),
		);
	}
	throw new Error(`${path} did not converge in 100 rounds`);
}

/**
 * Serve one inbound connection until the peer disconnects. This is the other
 * half of `syncRound` — same frames, same store, run by whoever is listening.
 */
export async function servePeer(w: Wire, store: Store): Promise<void> {
	let path: string | null = null;
	let doc: Automerge.Doc<Doc> | null = null;
	let state: SyncState | null = null;

	for (;;) {
		const bytes = await w.recv();
		if (!bytes) return;
		const frame = decodeFrame(bytes);

		switch (frame.t) {
			case 'files':
				await w.send(
					encodeFrame({
						t: 'files.reply',
						paths: await store.list(),
					}),
				);
				break;

			case 'open':
				path = frame.path;
				doc = loadDoc(await store.read(path));
				state = Automerge.initSyncState();
				break;

			case 'sync': {
				if (!doc || !state || frame.path !== path) {
					throw new Error(`sync for an unopened path: ${frame.path}`);
				}
				[doc, state] = Automerge.receiveSyncMessage(
					doc,
					state,
					base64ToBytes(frame.m),
				);
				const [, reply] = Automerge.generateSyncMessage(doc, state);
				if (reply) {
					await w.send(
						encodeFrame({
							t: 'sync',
							path: frame.path,
							m: bytesToBase64(reply),
						}),
					);
				} else {
					// We are in sync and have nothing left to send.
					if (hasContent(doc))
						await store.write(frame.path, saveDoc(doc));
					await w.send(encodeFrame({ t: 'done', path: frame.path }));
				}
				break;
			}

			case 'done':
				// The initiator says we agree. Save and confirm.
				if (doc && path && hasContent(doc))
					await store.write(path, saveDoc(doc));
				if (path) await w.send(encodeFrame({ t: 'done', path }));
				break;
		}
	}
}
