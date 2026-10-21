// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The gate for "does this actually load in Obsidian". I cannot click a button to
 * find out, so the plugin has to prove it here: WASM initializes, onload
 * finishes, the command registers, settings persist, and unload cleans up.
 */

import AutomergeSyncPlugin from "../src/main";
import { Notice } from "obsidian";
import { fakeVault } from "./helpers/fakeVault";

function makeApp() {
	const vault = fakeVault();
	const el = document.createElement("div");
	const mkdir = vi.fn(async () => {});
	return {
		vault: Object.assign(vault.io, { adapter: { ...vault.io.adapter, mkdir } }),
		mkdir,
		fileManager: { trashFile: vi.fn(async () => {}) },
		workspace: { containerEl: el },
	};
}

const MANIFEST = { id: "automerge-sync", version: "0.1.0" };

beforeEach(() => {
	vi.clearAllMocks();
	Notice.lastMessages = [];
});

describe("plugin loads in Obsidian", () => {
	it("onload finishes without throwing", async () => {
		const app = makeApp();
		const plugin = new AutomergeSyncPlugin(app as never, MANIFEST as never);
		await expect(plugin.onload()).resolves.not.toThrow();
		plugin.onunload();
	});

	it("registers the sync command", async () => {
		const plugin = new AutomergeSyncPlugin(makeApp() as never, MANIFEST as never);
		await plugin.onload();
		expect(Object.keys((plugin as never as { commands: object }).commands)).toEqual(["sync-now"]);
		plugin.onunload();
	});

	it("creates the document directory", async () => {
		const app = makeApp();
		const plugin = new AutomergeSyncPlugin(app as never, MANIFEST as never);
		await plugin.onload();
		// The folder that holds the CRDT documents must exist after load.
		expect(app.mkdir).toHaveBeenCalledWith(".automerge-sync");
		plugin.onunload();
	});

	it("starts with sync enabled and no peers", async () => {
		const plugin = new AutomergeSyncPlugin(makeApp() as never, MANIFEST as never);
		await plugin.onload();
		expect(plugin.config.sync).toBe(true);
		expect(plugin.config.peers).toEqual([]);
		plugin.onunload();
	});

	it("restores saved settings", async () => {
		const app = makeApp();
		const plugin = new AutomergeSyncPlugin(app as never, MANIFEST as never);
		(plugin as never as { loadData: () => Promise<unknown> }).loadData = async () => ({
			intervalMs: 60_000,
			peers: ["ws://10.0.0.5:8521"],
		});
		await plugin.onload();
		expect(plugin.config.intervalMs).toBe(60_000);
		expect(plugin.config.peers).toEqual(["ws://10.0.0.5:8521"]);
		plugin.onunload();
	});

	it("ignores unknown keys in saved settings", async () => {
		const plugin = new AutomergeSyncPlugin(makeApp() as never, MANIFEST as never);
		(plugin as never as { loadData: () => Promise<unknown> }).loadData = async () => ({
			nonsense: true,
			peers: "not an array",
		});
		await plugin.onload();
		expect(plugin.config.sync).toBe(true);
		expect(plugin.config.port).toBe(8521);
		plugin.onunload();
	});

	it("survives a listener that cannot start", async () => {
		const plugin = new AutomergeSyncPlugin(makeApp() as never, MANIFEST as never);
		await plugin.onload();
		// Turning the listener on must not reject onload or unload, whatever
		// the port situation is.
		plugin.config = { ...plugin.config, listen: true, port: 1 };
		await expect(plugin.restart()).resolves.not.toThrow();
		plugin.onunload();
	});

	it("tells the user when Sync now has nothing to do", async () => {
		const plugin = new AutomergeSyncPlugin(makeApp() as never, MANIFEST as never);
		await plugin.onload();
		await plugin.syncNow();
		expect(Notice.lastMessages.join(" ")).toMatch(/No peers configured/);
		plugin.onunload();
	});

	it("reports a failure for an unreachable peer instead of throwing", async () => {
		const plugin = new AutomergeSyncPlugin(makeApp() as never, MANIFEST as never);
		await plugin.onload();
		plugin.config = { ...plugin.config, peers: ["ws://127.0.0.1:1"] };
		await expect(plugin.syncNow()).resolves.not.toThrow();
		expect(Notice.lastMessages.join(" ")).toMatch(/failed/);
		plugin.onunload();
	});

	it("unload stops the timer and closes the listener", async () => {
		const app = makeApp();
		const plugin = new AutomergeSyncPlugin(app as never, MANIFEST as never);
		await plugin.onload();
		expect(() => plugin.onunload()).not.toThrow();
	});
});