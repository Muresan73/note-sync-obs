import { describe, it, expect, beforeAll } from "vitest";
import {
	SyncEngine,
	handlePeerSession,
	initSyncAutomerge,
	encodeNoteDoc,
	decodeNoteDoc,
	applyEdit,
	encodeFrame,
	decodeFrame,
	type SyncStore,
	type Transport,
	type SyncStatus,
} from "../src/sync/SyncEngine";

beforeAll(async () => {
	await initSyncAutomerge();
});

// ---------- Test infrastructure: two simulated plugin instances ----------

/** In-memory SyncStore, standing in for a second Obsidian vault. */
function memoryStore(): SyncStore & { files: Map<string, Uint8Array> } {
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

/**
 * Loopback pair: two Transports wired to each other with internal queues —
 * this simulates the network between two plugin instances.
 */
function loopbackPair(): [Transport, Transport] {
	const aToB: Uint8Array[] = [];
	const bToA: Uint8Array[] = [];
	let aClosed = false;
	let bClosed = false;

	const makeSide = (
		outbound: Uint8Array[],
		inbound: Uint8Array[],
		isClosed: () => boolean,
		setClosed: () => void,
		peerWake: { wake: (() => void) | null }, // wakes whoever waits on THIS side's receive
		ownWake: { wake: (() => void) | null },
	): Transport => ({
		async send(frame) {
			if (isClosed()) throw new Error("closed");
			outbound.push(frame);
			// Data just became available on the peer's inbound queue.
			const w = peerWake.wake;
			peerWake.wake = null;
			w?.();
		},
		receive() {
			if (inbound.length) return Promise.resolve(inbound.shift()!);
			if (isClosed()) return Promise.resolve(null);
			return new Promise((resolve) => {
				ownWake.wake = () => resolve(inbound.shift() ?? null);
			});
		},
		isOpen() {
			return !isClosed();
		},
		async close() {
			setClosed();
			const w = ownWake.wake;
			ownWake.wake = null;
			w?.();
		},
	});

	const aWake = { wake: null as (() => void) | null }; // waits on A.receive
	const bWake = { wake: null as (() => void) | null }; // waits on B.receive
	// A sends into aToB (B's inbound) and must wake bWake; vice versa.
	const a = makeSide(aToB, bToA, () => aClosed, () => (aClosed = true), bWake, aWake);
	const b = makeSide(bToA, aToB, () => bClosed, () => (bClosed = true), aWake, bWake);
	return [a, b];
}

/** Connect a SyncEngine (initiator) to a peer store via fresh loopbacks. */
function connectPair(engineStore: SyncStore, peerStore: SyncStore): SyncEngine {
	const engine = new SyncEngine(engineStore, {
		async connect() {
			// Fresh pair + fresh peer handler per connection, mirroring how a
			// real server accepts a new socket per sync round.
			const [tA, tB] = loopbackPair();
			void handlePeerSession(tB, peerStore).catch(() => {});
			return tA;
		},
	}, "loopback://test");
	return engine;
}

// ---------- Tests ----------

describe("frame codec", () => {
	it("round-trips JSON frames", () => {
		const frame = encodeFrame({ type: "file-list", paths: ["a.md", "b.md"] });
		const out = decodeFrame(frame);
		expect(out).toEqual({ type: "file-list", paths: ["a.md", "b.md"] });
	});

	it("round-trips binary sync message frames", () => {
		const payload = encodeNoteDoc({ path: "x.md", content: "hello", updatedAt: 1 });
		const frame = encodeFrame({ type: "sync", path: "x.md", message: payload });
		const out = decodeFrame(frame);
		expect(out.type).toBe("sync");
		expect(new Uint8Array((out as { message: Uint8Array }).message)).toEqual(payload);
	});
});

describe("two simulated plugin instances", () => {
	it("pushes a new local file to the peer", async () => {
		const vaultA = memoryStore();
		const vaultB = memoryStore();
		vaultA.files.set("notes/todo.md", encodeNoteDoc({ path: "notes/todo.md", content: "buy milk", updatedAt: 1 }));

		const engine = connectPair(vaultA, vaultB);
		const status = await engine.syncOnce();
		expect(status.state).toBe("synced");
		expect(status.filesSynced).toBe(1);

		// Peer now has the file with the same content.
		expect(vaultB.files.has("notes/todo.md")).toBe(true);
		const remote = decodeNoteDoc(vaultB.files.get("notes/todo.md")!);
		expect(remote.content).toBe("buy milk");
	});

	it("pulls a peer-only file into the local vault", async () => {
		const vaultA = memoryStore();
		const vaultB = memoryStore();
		vaultB.files.set("other.md", encodeNoteDoc({ path: "other.md", content: "from B", updatedAt: 2 }));

		const engine = connectPair(vaultA, vaultB);
		const status = await engine.syncOnce();
		expect(status.state).toBe("synced");

		expect(vaultA.files.has("other.md")).toBe(true);
		expect(decodeNoteDoc(vaultA.files.get("other.md")!).content).toBe("from B");
	});

	it("merges concurrent edits to different fields on both sides (CRDT)", async () => {
		const vaultA = memoryStore();
		const vaultB = memoryStore();

		// Same base doc on both replicas.
		const base = encodeNoteDoc({ path: "shared.md", content: "line1", updatedAt: 1 });
		vaultA.files.set("shared.md", base);
		vaultB.files.set("shared.md", base);

		// Concurrent edits: A changes content, B appends a marker field via
		// content2 (simulating a different note section). Field-level CRDT
		// merges keep both. NOTE: two concurrent assignments to the SAME
		// string field resolve last-writer-wins (Automerge semantics) — true
		// text merging needs spliceText and is a later milestone.
		const editedA = applyEdit(base, (d) => {
			d.content = "edited by A";
		});
		const editedB = applyEdit(base, (d) => {
			(d as unknown as Record<string, unknown>).content2 = "edited by B";
		});
		vaultA.files.set("shared.md", editedA);
		vaultB.files.set("shared.md", editedB);

		const engine = connectPair(vaultA, vaultB);
		const status = await engine.syncOnce();
		expect(status.state).toBe("synced");

		// Both replicas converged, both fields present.
		const docA = decodeNoteDoc(vaultA.files.get("shared.md")!) as unknown as Record<string, unknown>;
		const docB = decodeNoteDoc(vaultB.files.get("shared.md")!) as unknown as Record<string, unknown>;
		expect(docA.content).toBe("edited by A");
		expect(docB.content).toBe("edited by A");
		expect(docA.content2).toBe("edited by B");
		expect(docB.content2).toBe("edited by B");
	});

	it("syncs ALL files in both directions in one round", async () => {
		const vaultA = memoryStore();
		const vaultB = memoryStore();
		for (const p of ["a.md", "b.md", "c.md"]) {
			vaultA.files.set(p, encodeNoteDoc({ path: p, content: `A-${p}`, updatedAt: 1 }));
		}
		for (const p of ["d.md", "e.md"]) {
			vaultB.files.set(p, encodeNoteDoc({ path: p, content: `B-${p}`, updatedAt: 2 }));
		}
		// One shared file with different histories.
		const shared = encodeNoteDoc({ path: "shared.md", content: "base", updatedAt: 3 });
		vaultA.files.set("shared.md", shared);
		vaultB.files.set("shared.md", shared);

		const engine = connectPair(vaultA, vaultB);
		const status = await engine.syncOnce();
		expect(status.state).toBe("synced");
		expect(status.filesSynced).toBe(6);

		// Union of files exists on both sides.
		const pathsA = new Set(await vaultA.listFiles());
		const pathsB = new Set(await vaultB.listFiles());
		expect(pathsA).toEqual(pathsB);
		for (const p of ["a.md", "b.md", "c.md", "d.md", "e.md", "shared.md"]) {
			expect(pathsA.has(p)).toBe(true);
		}
		expect(decodeNoteDoc(vaultB.files.get("a.md")!).content).toBe("A-a.md");
		expect(decodeNoteDoc(vaultA.files.get("e.md")!).content).toBe("B-e.md");
	});

	it("second sync round is a no-op when nothing changed", async () => {
		const vaultA = memoryStore();
		const vaultB = memoryStore();
		vaultA.files.set("n.md", encodeNoteDoc({ path: "n.md", content: "x", updatedAt: 1 }));

		const engine = connectPair(vaultA, vaultB);
		await engine.syncOnce();
		const second = await engine.syncOnce();
		expect(second.state).toBe("synced");
		expect(second.filesSynced).toBe(1);
		// Content unchanged.
		expect(decodeNoteDoc(vaultB.files.get("n.md")!).content).toBe("x");
	});

	it("reports error state when the peer is unreachable", async () => {
		const vaultA = memoryStore();
		const engine = new SyncEngine(vaultA, {
			async connect() {
				throw new Error("connection refused");
			},
		}, "ws://nowhere");
		const statuses: SyncStatus[] = [];
		engine.onStatus((s) => statuses.push(s));
		const status = await engine.syncOnce();
		expect(status.state).toBe("error");
		expect(status.error).toContain("connection refused");
		expect(statuses.some((s) => s.state === "error")).toBe(true);
	});

	it("emits status transitions during a successful sync", async () => {
		const vaultA = memoryStore();
		const vaultB = memoryStore();
		vaultA.files.set("n.md", encodeNoteDoc({ path: "n.md", content: "x", updatedAt: 1 }));
		const engine = connectPair(vaultA, vaultB);
		const states: string[] = [];
		engine.onStatus((s) => states.push(s.state));
		await engine.syncOnce();
		expect(states).toContain("connecting");
		expect(states).toContain("syncing");
		expect(states).toContain("synced");
	});
});
