// Smoke test against the built plugin.
//
// The bug this exists to catch: the plugin failed to load in Obsidian with
// "Cannot find module 'ws'". `ws` was marked external so that it would not
// resolve to its browser stub (which has no WebSocketServer) — but external
// also means `require("ws")` at runtime, and a plugin folder with no
// node_modules dies on load.
//
// The fix is `platform: "node"`, which makes esbuild resolve the real CommonJS
// build and bundle it. So main.js must now be self-contained: if a runtime
// require of ws ever comes back, this test fails and so does the build.
import { readFileSync, existsSync } from "node:fs";

const main = readFileSync(new URL("../main.js", import.meta.url), "utf8");

if (!/AGFzbQ/.test(main)) {
	throw new Error("main.js does not embed the Automerge WASM base64 blob");
}

// The failure mode: an unresolved require, because ws was external.
if (/require\(\s*["']ws["']\s*\)/.test(main)) {
	throw new Error(
		'main.js still requires "ws" at runtime — a plugin folder has no node_modules. ' +
			"Remove \"ws\" from esbuild external and set platform: \"node\" so it bundles.",
	);
}

// ws bundled into the browser stub instead of the real thing: no server, so
// the listener throws "WebSocketServer is not a constructor" on enable.
for (const marker of ["Sec-WebSocket-Accept", "permessage-deflate"]) {
	if (!main.includes(marker)) {
		throw new Error(`main.js does not look like it bundles ws (missing ${marker})`);
	}
}

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
for (const key of ["id", "name", "version", "minAppVersion", "description"]) {
	if (typeof manifest[key] !== "string" || manifest[key].length === 0) {
		throw new Error(`manifest.json missing field: ${key}`);
	}
}
if (manifest.id !== "automerge-sync") {
	throw new Error(`manifest id should be automerge-sync, got ${manifest.id}`);
}
if (!manifest.isDesktopOnly) {
	throw new Error("this plugin uses node built-ins and must be desktop-only");
}

console.log("smoke OK: wasm embedded, ws bundled, manifest valid");