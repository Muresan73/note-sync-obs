import { App, PluginSettingTab, Setting } from "obsidian";
import type AutomergeSyncPlugin from "../main";

export interface SyncSettings {
	serverUrl: string;
	syncIntervalMs: number;
	syncEnabled: boolean;
}

export const DEFAULT_SETTINGS: SyncSettings = {
	serverUrl: "ws://localhost:8080",
	syncIntervalMs: 30000,
	syncEnabled: false,
};

export class SyncSettingTab extends PluginSettingTab {
	plugin: AutomergeSyncPlugin;

	constructor(app: App, plugin: AutomergeSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Automerge Sync" });

		new Setting(containerEl)
			.setName("Sync enabled")
			.setDesc("Run background sync with the server below.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.syncEnabled).onChange(async (v) => {
					this.plugin.settings.syncEnabled = v;
					await this.plugin.saveSettings();
					await this.plugin.restartSync();
				}),
			);

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("WebSocket endpoint of the sync server (e.g. ws://localhost:8080).")
			.addText((t) =>
				t.setValue(this.plugin.settings.serverUrl).onChange(async (v) => {
					this.plugin.settings.serverUrl = v.trim();
					await this.plugin.saveSettings();
					await this.plugin.restartSync();
				}),
			);

		new Setting(containerEl)
			.setName("Sync interval (seconds)")
			.setDesc("How often to sync in the background.")
			.addText((t) =>
				t.setValue(String(Math.round(this.plugin.settings.syncIntervalMs / 1000))).onChange(async (v) => {
					const secs = parseInt(v, 10);
					if (!Number.isNaN(secs) && secs >= 5) {
						this.plugin.settings.syncIntervalMs = secs * 1000;
						await this.plugin.saveSettings();
						await this.plugin.restartSync();
					}
				}),
			);
	}
}
