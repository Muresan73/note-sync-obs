/**
 * WebSocket transport + connection factory for the browser/Obsidian renderer.
 * Wraps the engine's Transport interface over the WHATWG WebSocket API.
 */
import type { Transport, PeerConnectionFactory } from "./SyncEngine";

export class WebSocketTransport implements Transport {
	private queue: Uint8Array[] = [];
	private wake: (() => void) | null = null;
	private closed = false;

	constructor(private readonly ws: WebSocket) {
		ws.binaryType = "arraybuffer";
		ws.addEventListener("message", (ev) => {
			const data =
				ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(ev.data as ArrayBuffer);
			this.queue.push(data);
			const w = this.wake;
			this.wake = null;
			w?.();
		});
		ws.addEventListener("close", () => {
			this.closed = true;
			const w = this.wake;
			this.wake = null;
			w?.();
		});
		ws.addEventListener("error", () => {
			this.closed = true;
			const w = this.wake;
			this.wake = null;
			w?.();
		});
	}

	send(frame: Uint8Array): Promise<void> {
		if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("socket closed"));
		}
		// Copy: the caller may reuse the buffer.
		const copy = frame.slice();
		this.ws.send(copy);
		return Promise.resolve();
	}

	receive(): Promise<Uint8Array | null> {
		if (this.queue.length) {
			return Promise.resolve(this.queue.shift()!);
		}
		if (this.closed) return Promise.resolve(null);
		return new Promise((resolve) => {
			this.wake = () => {
				resolve(this.queue.shift() ?? null);
			};
		});
	}

	isOpen(): boolean {
		return this.ws.readyState === WebSocket.OPEN;
	}

	async close(): Promise<void> {
		if (this.ws.readyState !== WebSocket.CLOSED) {
			this.ws.close();
		}
	}
}

export class WebSocketConnectionFactory implements PeerConnectionFactory {
	constructor(private readonly protocolFactory: (url: string) => WebSocket) {}

	connect(url: string): Promise<Transport> {
		return new Promise((resolve, reject) => {
			let ws: WebSocket;
			try {
				ws = this.protocolFactory(url);
			} catch (e) {
				reject(e);
				return;
			}
			const onOpen = () => {
				cleanup();
				resolve(new WebSocketTransport(ws));
			};
			const onError = () => {
				cleanup();
				reject(new Error(`connection to ${url} failed`));
			};
			const cleanup = () => {
				ws.removeEventListener("open", onOpen);
				ws.removeEventListener("error", onError);
			};
			ws.addEventListener("open", onOpen);
			ws.addEventListener("error", onError);
		});
	}
}
