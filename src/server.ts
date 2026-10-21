/**
 * The inbound listener. Each vault can serve its peers as well as dial them.
 *
 * The important part: it uses the same Store as the dialer. A listener that
 * merged into memory instead would accept everything and lose all of it.
 */
import { WebSocketServer } from "ws";
import { wire, servePeer, type Store } from "./sync";

export interface Listener {
	port: number;
	close(): Promise<void>;
}

export async function listen(store: Store, port: number): Promise<Listener> {
	const wss = new WebSocketServer({ port });

	await new Promise<void>((resolve, reject) => {
		wss.once("listening", resolve);
		wss.once("error", reject);
	});

	wss.on("connection", (ws) => {
		ws.binaryType = "arraybuffer";
		const { wire: pipe, push, hangup } = wire(
			(bytes) => ws.send(bytes),
			() => ws.close(),
		);
		ws.on("message", (data: ArrayBuffer) => push(new Uint8Array(data)));
		ws.on("close", hangup);
		ws.on("error", hangup);

		servePeer(pipe, store).catch((e) => {
			console.error("[automerge-sync] peer session ended:", e instanceof Error ? e.message : e);
			ws.terminate();
		});
	});

	const bound = wss.address();
	return {
		port: typeof bound === "object" && bound ? bound.port : port,
		close: () =>
			new Promise<void>((resolve) => {
				for (const ws of wss.clients) ws.terminate();
				wss.close(() => resolve());
			}),
	};
}