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
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins,
	],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: prod,
	// automerge /slim and the base64 blob are pure JS — no conditions needed.
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
