import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

// WASM strategy: we import @automerge/automerge/slim and the base64-encoded
// wasm blob (@automerge/automerge/automerge.wasm.base64.js). Both are pure JS
// modules, so esbuild bundles them into main.js with no .wasm asset handling,
// no externals, and no runtime fetch. This is the documented Automerge path
// for environments where only JS files can be loaded (Obsidian plugins).

const prod = process.argv[2] === "production";

const context = await esbuild.context({
	banner: {
		js: `'use strict';
// Symbol polyfill for the Obsidian renderer environment.
if (typeof window !== 'undefined' && typeof window.Symbol === 'undefined') {
	window.Symbol = Symbol;
}
`,
	},
	entryPoints: ["src/main.ts"],
	bundle: true,
	// platform:node makes esbuild resolve `ws` to its CommonJS build rather than
	// the browser stub, which has no WebSocketServer. With this set, ws bundles
	// cleanly and the plugin becomes a single self-contained main.js — no
	// node_modules to ship alongside it.
	platform: "node",
	external: ["obsidian", "electron", ...builtins],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: prod,
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}