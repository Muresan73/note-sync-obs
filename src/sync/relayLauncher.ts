/**
 * CLI launcher for the relay hub (bundled to relay.mjs by scripts/build-relay.mjs).
 * The logic lives in src/sync/relayServer.ts so tests start it in-process.
 *
 * Usage: node relay.mjs [port]   (default 8080)
 */
import { startRelayServer } from "./relayServer";
import { initSyncAutomerge } from "./SyncEngine";

const port = parseInt(process.argv[2] || "8080", 10);

await initSyncAutomerge();
const server = await startRelayServer(port);
console.log(`Automerge relay hub listening on ws://0.0.0.0:${server.port}`);
console.log(`Point both vaults' Server URL at ws://localhost:${port}`);
console.log("Ctrl+C to stop.");

process.on("SIGINT", async () => {
	await server.close();
	process.exit(0);
});
