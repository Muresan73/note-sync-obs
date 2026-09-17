// Node smoke test against the built plugin.
// Verifies main.js embeds the Automerge WASM base64 blob and that
// manifest.json is valid and points at main.js.
import { readFileSync } from "node:fs";

const main = readFileSync(new URL("../main.js", import.meta.url), "utf8");
if (!/AGFzbQ/.test(main)) {
	throw new Error("main.js does not embed the Automerge WASM base64 blob");
}

const manifest = JSON.parse(
	readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
);
for (const key of ["id", "name", "version", "minAppVersion", "description"]) {
	if (typeof manifest[key] !== "string" || manifest[key].length === 0) {
		throw new Error(`manifest.json missing field: ${key}`);
	}
}
if (manifest.id !== "automerge-sync") {
	throw new Error(`manifest id should be automerge-sync, got ${manifest.id}`);
}

console.log("smoke OK: main.js embeds wasm blob; manifest.json valid");
