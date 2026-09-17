import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startRelayServer, type RelayServer } from '../src/sync/relayServer';
import { WebSocketConnectionFactory } from '../src/sync/WebSocketTransport';
import {
	SyncEngine,
	initSyncAutomerge,
	applyEdit,
	encodeNoteDoc,
	decodeNoteDoc,
	type SyncStore,
	type SyncStatus,
} from '../src/sync/SyncEngine';

/**
 * End-to-end integration test WITHOUT Obsidian:
 * a real relay hub server (in-process, real WebSocket port) + two simulated
 * plugin instances (SyncEngine + in-memory vault stores) connecting over
 * real WebSockets, with realistic note data.
 */

beforeAll(async () => {
	await initSyncAutomerge();
});

// ---------- test helpers ----------

function memoryVault(): SyncStore & { files: Map<string, Uint8Array> } {
	const files = new Map<string, Uint8Array>();
	return {
		files,
		async listFiles() {
			return [...files.keys()];
		},
		async readDoc(p) {
			return files.get(p) ?? null;
		},
		async writeDoc(p, bytes) {
			files.set(p, bytes);
		},
	};
}

interface Instance {
	vault: ReturnType<typeof memoryVault>;
	engine: SyncEngine;
}

function makeInstance(url: string): Instance {
	const vault = memoryVault();
	const engine = new SyncEngine(
		vault,
		new WebSocketConnectionFactory((u) => new WebSocket(u)),
		url,
	);
	return { vault, engine };
}

/** Realistic seed data: meeting notes, a journal, a project doc. */
function seedMeetingNotes(): Uint8Array {
	return encodeNoteDoc({
		path: 'meetings/2026-09-17 standup.md',
		content: '# Standup\n\n- shipped sync engine\n- next: text merging',
		updatedAt: 1758100000000,
	});
}

function seedJournal(): Uint8Array {
	return encodeNoteDoc({
		path: 'journal/2026-09-17.md',
		content: 'Today the relay finally worked end to end.',
		updatedAt: 1758100001000,
	});
}

// ---------- tests ----------

describe('relay hub ↔ two plugin instances (real WebSockets, no Obsidian)', () => {
	let relay: RelayServer;
	let url: string;

	beforeAll(async () => {
		relay = await startRelayServer(0); // port 0 = OS picks a free port
		// The ws server with port 0 reports its real port via address().
		url = `ws://127.0.0.1:${relay.port}`;
	});

	afterAll(async () => {
		await relay.close();
	});

	it('vault A pushes files to the hub, vault B pulls them', async () => {
		const a = makeInstance(url);
		const b = makeInstance(url);

		// A has meeting notes + journal; B is empty.
		a.vault.files.set('meetings/2026-09-17 standup.md', seedMeetingNotes());
		a.vault.files.set('journal/2026-09-17.md', seedJournal());

		const s1: SyncStatus = await a.engine.syncOnce();
		expect(s1.state).toBe('synced'); // A → hub
		const f1 = await relay.store.listFiles();
		expect(f1.length).toBe(2);

		const s2: SyncStatus = await b.engine.syncOnce();
		expect(s2.state).toBe('synced'); // B ← hub
		expect(s2.filesSynced).toBe(2);

		// B now has both files with identical content.
		const remote = decodeNoteDoc(
			b.vault.files.get('meetings/2026-09-17 standup.md')!,
		);
		expect(remote.content).toContain('shipped sync engine');
		const journal = decodeNoteDoc(
			b.vault.files.get('journal/2026-09-17.md')!,
		);
		expect(journal.content).toContain('end to end');
	});

	it('vault B creates a file; vault A picks it up from the hub', async () => {
		const a = makeInstance(url);
		const b = makeInstance(url);

		b.vault.files.set(
			'projects/relay.md',
			encodeNoteDoc({
				path: 'projects/relay.md',
				content: 'hub design notes',
				updatedAt: 2,
			}),
		);

		await b.engine.syncOnce(); // B → hub
		const status = await a.engine.syncOnce(); // A ← hub
		expect(status.state).toBe('synced');

		expect(a.vault.files.has('projects/relay.md')).toBe(true);
		expect(
			decodeNoteDoc(a.vault.files.get('projects/relay.md')!).content,
		).toBe('hub design notes');
	});

	it('concurrent edits from both vaults converge through the hub (CRDT)', async () => {
		const a = makeInstance(url);
		const b = makeInstance(url);

		// Both start from the same base doc (already on the hub via A).
		const base = encodeNoteDoc({
			path: 'notes/crdt.md',
			content: 'base content',
			updatedAt: 1,
		});
		a.vault.files.set('notes/crdt.md', base);
		await a.engine.syncOnce();

		// B pulls the base…
		await b.engine.syncOnce();
		// …then both edit concurrently (different fields → both survive).
		a.vault.files.set(
			'notes/crdt.md',
			applyEdit(a.vault.files.get('notes/crdt.md')!, (d) => {
				d.content = 'edited by A';
			}),
		);
		b.vault.files.set(
			'notes/crdt.md',
			applyEdit(b.vault.files.get('notes/crdt.md')!, (d) => {
				(d as unknown as Record<string, unknown>).extra = 'edited by B';
			}),
		);

		await a.engine.syncOnce(); // A → hub
		await b.engine.syncOnce(); // B ↔ hub (gets A's edit, pushes its own)
		await a.engine.syncOnce(); // A ← hub (gets B's edit)

		const docA = decodeNoteDoc(
			a.vault.files.get('notes/crdt.md')!,
		) as unknown as Record<string, unknown>;
		const docB = decodeNoteDoc(
			b.vault.files.get('notes/crdt.md')!,
		) as unknown as Record<string, unknown>;
		expect(docA.content).toBe('edited by A');
		expect(docB.content).toBe('edited by A');
		expect(docA.extra).toBe('edited by B');
		expect(docB.extra).toBe('edited by B');

		// Hub holds the merged result too.
		const hubDoc = decodeNoteDoc(
			(await relay.store.readDoc('notes/crdt.md'))!,
		) as unknown as Record<string, unknown>;
		expect(hubDoc.content).toBe('edited by A');
		expect(hubDoc.extra).toBe('edited by B');
	});

	it('a second sync round with no changes is a clean no-op', async () => {
		// Dedicated hub: asserts per-round behavior in isolation, independent
		// of files other tests left on the shared hub.
		const isolated = await startRelayServer(0);
		try {
			const a = makeInstance(`ws://127.0.0.1:${isolated.port}`);
			a.vault.files.set(
				'solo.md',
				encodeNoteDoc({ path: 'solo.md', content: 'quiet', updatedAt: 9 }),
			);

			await a.engine.syncOnce();
			const second = await a.engine.syncOnce();
			expect(second.state).toBe('synced');
			expect(second.filesSynced).toBe(1);
		} finally {
			await isolated.close();
		}
	});

	it('hub status reflects only engines; error surfaces when hub is down', async () => {
		const dead = makeInstance('ws://127.0.0.1:1'); // nothing listens here
		const status = await dead.engine.syncOnce();
		expect(status.state).toBe('error');
		expect(status.error).toMatch(/failed/i);
	});
});
