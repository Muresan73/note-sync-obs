// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Plugin boundary tests: mock the minimum Obsidian surface so we can
 * instantiate the plugin class without launching Obsidian.
 * The vitest config aliases "obsidian" to tests/mocks/obsidian.ts (the real
 * npm package is types-only); here we additionally spy on Notice.
 */

import AutomergeSyncPlugin from "../src/main";

function makeApp() {
	return {
		vault: {
			adapter: {
				exists: vi.fn(async () => false),
				readBinary: vi.fn(async () => {
					throw new Error("missing");
				}),
				writeBinary: vi.fn(async () => {}),
				mkdir: vi.fn(async () => {}),
			},
		},
		workspace: { containerEl: document.createElement("div") },
	};
}

const MANIFEST = { id: "automerge-sync", version: "0.1.0" };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("plugin boundary", () => {
	it("onload registers the expected commands", async () => {
		const plugin = new AutomergeSyncPlugin(makeApp() as any, MANIFEST as any);
		await plugin.onload();
		const ids = Object.keys((plugin as any).commands);
		expect(ids).toContain("create-or-update-sample");
		expect(ids).toContain("show-sample");
	});

	it("create-or-update-sample calls the document service and writes bytes", async () => {
		const app = makeApp();
		const plugin = new AutomergeSyncPlugin(app as any, MANIFEST as any);
		await plugin.onload();
		await (plugin as any).commands["create-or-update-sample"].callback();
		const write = app.vault.adapter.writeBinary as ReturnType<typeof vi.fn>;
		// tmp + final write, binary payload only
		expect(write).toHaveBeenCalled();
		const payload = write.mock.calls[0][1] as ArrayBuffer;
		expect(payload).toBeInstanceOf(ArrayBuffer);
		expect(payload.byteLength).toBeGreaterThan(0);
	});

	it("show-sample reports a Notice on missing file", async () => {
		const app = makeApp();
		const plugin = new AutomergeSyncPlugin(app as any, MANIFEST as any);
		await plugin.onload();
		const { Notice } = await import("obsidian");
		(Notice as any).lastMessages = [];
		await expect((plugin as any).commands["show-sample"].callback()).resolves.not.toThrow();
		expect(
			(Notice as any).lastMessages.some((n: string) => /Failed to load sample document/.test(n)),
		).toBe(true);
	});
});
