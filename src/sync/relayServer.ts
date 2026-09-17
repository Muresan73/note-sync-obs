/**
 * Relay hub server.
 *
 * Unlike a dumb pipe, the hub is a real Automerge peer: it stores documents
 * (in-memory by default) and runs `handlePeerSession` against every incoming
 * WebSocket connection. This means plugins can connect independently — no
 * pairing, no need for two clients to be online at the same time.
 *
 * Used by relay.mjs (CLI launcher) and by tests (in-process).
 */
import { WebSocketServer, WebSocket as WsClient } from "ws";
import {
	handlePeerSession,
	type SyncStore,
	type Transport,
} from "./SyncEngine";

/** In-memory document store for the hub (swap for a disk store if needed). */
export function memoryHubStore(): SyncStore {
	const files = new Map<string, Uint8Array>();
	return {
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

/** Adapt a ws server-side socket to the engine's Transport interface. */
export class WsServerTransport implements Transport {
	private queue: Uint8Array[] = [];
	private wake: (() => void) | null = null;
	private closed = false;

	constructor(private readonly ws: WsClient) {
		ws.on("message", (data: Buffer) => {
			this.queue.push(new Uint8Array(data));
			const w = this.wake;
			this.wake = null;
			w?.();
		});
		ws.on("close", () => {
			this.closed = true;
			const w = this.wake;
			this.wake = null;
			w?.();
		});
		ws.on("error", () => {
			this.closed = true;
			const w = this.wake;
			this.wake = null;
			w?.();
		});
	}

	async send(frame: Uint8Array): Promise<void> {
		if (this.closed || this.ws.readyState !== 1 /* OPEN */) {
			throw new Error("socket closed");
		}
		this.ws.send(frame.slice());
	}

	async receive(): Promise<Uint8Array | null> {
		if (this.queue.length) return this.queue.shift()!;
		if (this.closed) return null;
		return new Promise((resolve) => {
			this.wake = () => resolve(this.queue.shift() ?? null);
		});
	}

	isOpen(): boolean {
		return this.ws.readyState === 1;
	}

	async close(): Promise<void> {
		if (this.ws.readyState !== 3) this.ws.close();
	}
}

export interface RelayServer {
	/** The actual bound port (useful when requesting port 0). */
	port: number;
	store: SyncStore;
	close(): Promise<void>;
}

/** Start the hub. Resolves once the server is listening. */
export function startRelayServer(
	port: number,
	store: SyncStore = memoryHubStore(),
): Promise<RelayServer> {
	return new Promise((resolve, reject) => {
		const wss = new WebSocketServer({ port });
		wss.on("error", reject);
		wss.on("listening", () => {
			const addr = wss.address();
			const boundPort = typeof addr === "object" && addr !== null ? addr.port : port;
			resolve({
				port: boundPort,
				store,
				async close() {
					for (const client of wss.clients) client.terminate();
					await new Promise<void>((res) => wss.close(() => res()));
				},
			});
		});
		wss.on("connection", (ws: WsClient) => {
			const transport = new WsServerTransport(ws);
			// One peer session per connection; ends when the plugin closes.
			void handlePeerSession(transport, store).catch((e) => {
				console.error("[relay] session error:", e);
				ws.close();
			});
		});
	});
}
