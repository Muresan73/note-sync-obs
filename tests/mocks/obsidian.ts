/**
 * Minimal Obsidian runtime stub for tests. The real `obsidian` npm package is
 * types-only (no JS entry), so vitest aliases "obsidian" to this file.
 *
 * Only what the plugin touches. TFile must be a real class because the vault
 * bridge uses `instanceof TFile` to tell files from folders.
 */

export class TAbstractFile {
	path = "";
	name = "";
}

export class TFile extends TAbstractFile {
	extension = "";
	stat = { mtime: 0, ctime: 0, size: 0 };
}

export class Notice {
	static lastMessages: string[] = [];
	public message: string;
	constructor(message: string) {
		this.message = message;
		Notice.lastMessages.push(message);
	}
	hide(): void {}
}

export class Plugin {
	app: any;
	manifest: any;
	commands: Record<string, { id: string; name: string; callback: () => void }> = {};
	constructor(app?: unknown, manifest?: unknown) {
		this.app = app;
		this.manifest = manifest;
	}
	addCommand(cmd: { id: string; name: string; callback: () => void }) {
		this.commands[cmd.id] = cmd;
		return cmd;
	}
	addStatusBarItem(): HTMLElement {
		const el = document.createElement("span");
		(el as unknown as { setText: (s: string) => void }).setText = (s: string) => {
			el.textContent = s;
		};
		return el;
	}
	addSettingTab(): void {}
	registerEvent(): void {}
	registerDomEvent(): void {}
	async loadData(): Promise<unknown> {
		return null;
	}
	async saveData(): Promise<void> {}
}

/** Enough of Setting for the settings tab to build rows without a real DOM. */
export class Setting {
	constructor(public containerEl?: unknown) {}
	setName(): this {
		return this;
	}
	setDesc(): this {
		return this;
	}
	addToggle(): this {
		return this;
	}
	addText(): this {
		return this;
	}
	addButton(): this {
		return this;
	}
	addExtraButton(): this {
		return this;
	}
}

export class PluginSettingTab {
	containerEl: HTMLElement = document.createElement("div");
	constructor(
		public app?: unknown,
		public plugin?: unknown,
	) {}
	display(): void {}
	hide(): void {}
}

export const normalizePath = (p: string): string => p;