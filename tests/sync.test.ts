/**
 * Two vaults, syncing. The point of these tests is that they go through a real
 * socket between two real Stores, because every bug worth catching here lived
 * in the wiring between the protocol and the filesystem — not in the protocol.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { syncRound, wire, servePeer, type Store } from "../src/sync";
import { listen } from "../src/server";
import { vaultStore } from "../src/vault";
import { fakeVault, pngBytes } from "./helpers/fakeVault";

/** Dial a listener and run one round through it. Mirrors what the plugin
 *  does: connecting is the caller's job, and its failure is a result, not a
 *  crash. */
async function roundTo(address: string, store: Store) {
	let ws: WebSocket;
	try {
		ws = await new Promise<WebSocket>((resolve, reject) => {
			const sock = new WebSocket(address);
			sock.once("open", () => resolve(sock));
			sock.once("error", (e) => reject(e instanceof Error ? e : new Error(String(e))));
		});
	} catch (e) {
		return { ok: false as const, files: 0, error: e instanceof Error ? e.message : String(e) };
	}

	ws.binaryType = "arraybuffer";
	const { wire: pipe, push, hangup } = wire(
		(bytes) => ws.send(bytes),
		() => ws.close(),
	);
	ws.on("message", (d: ArrayBuffer) => push(new Uint8Array(d)));
	ws.on("close", hangup);
	ws.on("error", hangup);

	const result = await syncRound(store, pipe);
	await pipe.close().catch(() => {});
	return result;
}

describe("two vaults over a real socket", () => {
	let server: WebSocketServer;
	let address: string;
	let peer: ReturnType<typeof fakeVault>;
	let peerStore: Store;

	beforeEach(async () => {
		server = new WebSocketServer({ port: 0 });
		await new Promise((r) => server.once("listening", r));
		const port = (server.address() as { port: number }).port;
		address = `ws://127.0.0.1:${port}`;

		peer = fakeVault();
		peerStore = vaultStore(peer.io);

		// The listening vault serves from its own real store. This is the bug
		// that shipped: it used to serve from an in-memory Map and lose
		// everything it accepted.
		server.on("connection", (ws) => {
			ws.binaryType = "arraybuffer";
			const { wire: pipe, push, hangup } = wire(
				(bytes) => ws.send(bytes),
				() => ws.close(),
			);
			ws.on("message", (d: ArrayBuffer) => push(new Uint8Array(d)));
			ws.on("close", hangup);
			ws.on("error", hangup);
			servePeer(pipe, peerStore).catch(() => ws.terminate());
		});
	});

	afterEach(async () => {
		await new Promise((r) => server.close(() => r(undefined)));
	});

	it("carries a note to the listening vault and keeps it there", async () => {
		const laptop = fakeVault();
		laptop.addNote("ideas.md", "written on the laptop");

		const result = await roundTo(address, vaultStore(laptop.io));

		expect(result.ok).toBe(true);
		expect(peer.text("ideas.md")).toBe("written on the laptop");
	});

	it("survives the connection closing: the peer keeps the note", async () => {
		const laptop = fakeVault();
		laptop.addNote("ideas.md", "durable");

		await roundTo(address, vaultStore(laptop.io));

		// A second vault syncs nothing and the first note must still be there.
		const other = fakeVault();
		await roundTo(address, vaultStore(other.io));
		expect(peer.text("ideas.md")).toBe("durable");
	});

	it("carries an image across byte for byte", async () => {
		const original = pngBytes(9);
		const laptop = fakeVault();
		laptop.addBinary("img/diagram.png", original);

		await roundTo(address, vaultStore(laptop.io));

		expect(peer.bytes("img/diagram.png")).toEqual(original);
	});

	it("pulls a note down from the peer", async () => {
		peer.addNote("server-only.md", "kept on the server");

		const laptop = fakeVault();
		await roundTo(address, vaultStore(laptop.io));

		expect(laptop.text("server-only.md")).toBe("kept on the server");
	});

	it("merges concurrent edits and converges both sides", async () => {
		const laptop = fakeVault();
		laptop.addNote("shared.md", "base");
		await roundTo(address, vaultStore(laptop.io));
		const laptopStore = vaultStore(laptop.io);

		// Each side edits from the same base.
		laptop.editNote("shared.md", "laptop edit");
		peer.editNote("shared.md", "server edit");

		await roundTo(address, laptopStore);

		// Automerge resolved it; both files must agree whichever way it went.
		const second = await roundTo(address, laptopStore);
		expect(second.ok).toBe(true);
		expect(laptop.text("shared.md")).toBe(peer.text("shared.md"));
		expect(laptop.text("shared.md")).not.toBe("");
	});

	it("deletes on one side and it stays deleted on the other", async () => {
		const laptop = fakeVault();
		laptop.addNote("temp.md", "temporary");
		const laptopStore = vaultStore(laptop.io);
		await roundTo(address, laptopStore);
		expect(peer.text("temp.md")).toBe("temporary");

		laptop.files.delete("temp.md");
		await roundTo(address, laptopStore);
		expect(peer.text("temp.md")).toBeUndefined();

		// A second round must not bring it back.
		await roundTo(address, laptopStore);
		expect(peer.text("temp.md")).toBeUndefined();
	});

	it("does nothing when there is nothing to do", async () => {
		const laptop = fakeVault();
		laptop.addNote("quiet.md", "settled");
		const laptopStore = vaultStore(laptop.io);
		await roundTo(address, laptopStore);

		const before = peer.text("quiet.md");
		await roundTo(address, laptopStore);
		expect(peer.text("quiet.md")).toBe(before);
	});
});

describe("when a peer is unreachable", () => {
	it("reports the failure instead of throwing", async () => {
		const vault = fakeVault();
		// Nothing is listening on this port.
		const result = await roundTo("ws://127.0.0.1:1", vaultStore(vault.io));
		expect(result.ok).toBe(false);
	});
});

describe("the embedded listener", () => {
	it("serves the store it was given and reports its port", async () => {
		const server = fakeVault();
		server.addNote("backup.md", "already here");

		const listener = await listen(vaultStore(server.io), 0);
		expect(listener.port).toBeGreaterThan(0);

		// The note predates any peer, so it must not be lost when one connects.
		const laptop = fakeVault();
		const result = await roundTo(`ws://127.0.0.1:${listener.port}`, vaultStore(laptop.io));

		expect(result.ok).toBe(true);
		expect(laptop.text("backup.md")).toBe("already here");
		await listener.close();
	});

	it("stops listening when closed", async () => {
		const listener = await listen(vaultStore(fakeVault().io), 0);
		const address = `ws://127.0.0.1:${listener.port}`;
		await listener.close();

		const result = await roundTo(address, vaultStore(fakeVault().io));
		expect(result.ok).toBe(false);
	});
});