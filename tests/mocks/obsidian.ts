/**
 * Minimal Obsidian runtime stub for tests. The real `obsidian` npm package is
 * types-only (no JS entry), so vitest aliases "obsidian" to this file.
 */
export class Notice {
	static lastMessages: string[] = [];
	public message: string;
	constructor(message: string) {
		this.message = message;
		Notice.lastMessages.push(message);
	}
	hide(): void {}
}

export class Modal {
	contentEl: HTMLElement = document.createElement("div");
	constructor(public app?: unknown) {}
	open(): void {}
	close(): void {}
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
	registerEvent(): void {}
	registerDomEvent(): void {}
	async loadData(): Promise<unknown> {
		return null;
	}
	async saveData(): Promise<void> {}
}

export const normalizePath = (p: string): string => p;
