/**
 * The settings tab. Five fields and a peer list, nothing else.
 */
import { PluginSettingTab, Setting, type App } from "obsidian";
import type AutomergeSyncPlugin from "./main";

export type Config = {
	/** Run on a timer. Off means only the Sync now command works. */
	sync: boolean;
	intervalMs: number;
	/** Accept inbound connections. */
	listen: boolean;
	port: number;
	/** `ws://` or `wss://` addresses of the other vaults. */
	peers: string[];
};

export class Settings extends PluginSettingTab {
	constructor(app: App, private readonly plugin: AutomergeSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const config = this.plugin.config;

		new Setting(containerEl)
			.setName("Sync automatically")
			.setDesc("Otherwise only the Sync now command syncs.")
			.addToggle((t) =>
				t.setValue(config.sync).onChange(async (on) => {
					config.sync = on;
					await this.plugin.restart();
				}),
			);

		new Setting(containerEl)
			.setName("Sync every")
			.setDesc("Seconds between rounds.")
			.addText((t) =>
				t.setValue(String(Math.round(config.intervalMs / 1000))).onChange(async (v) => {
					const seconds = Number(v);
					if (!Number.isFinite(seconds) || seconds < 5) return;
					config.intervalMs = seconds * 1000;
					await this.plugin.restart();
				}),
			);

		new Setting(containerEl)
			.setName("Accept connections")
			.setDesc("Serve other vaults on this machine.")
			.addToggle((t) =>
				t.setValue(config.listen).onChange(async (on) => {
					config.listen = on;
					await this.plugin.restart();
				}),
			);

		if (config.listen) {
			new Setting(containerEl).setName("Port").addText((t) =>
				t.setValue(String(config.port)).onChange(async (v) => {
					const port = Number(v);
					if (!Number.isInteger(port) || port < 1 || port > 65535) return;
					config.port = port;
					await this.plugin.restart();
				}),
			);
		}

		containerEl.createEl("h3", { text: "Peers" });

		for (const address of [...config.peers]) {
			const setting = new Setting(containerEl).setName(address);
			setting.addExtraButton((b) =>
				b.setIcon("trash")
					.setTooltip("Remove")
					.onClick(async () => {
						config.peers = config.peers.filter((p) => p !== address);
						await this.plugin.restart();
						this.display();
					}),
			);
		}

		let draft = "";
		new Setting(containerEl)
			.setName("Add a peer")
			.setDesc("For example ws://192.168.1.10:8521")
			.addText((t) =>
				t.setPlaceholder("ws://192.168.1.10:8521").onChange((v) => {
					draft = v.trim();
				}),
			)
			.addButton((b) =>
				b.setButtonText("Add").onClick(async () => {
					if (!draft || config.peers.includes(draft)) return;
					config.peers.push(draft);
					await this.plugin.restart();
					this.display();
				}),
			);
	}
}