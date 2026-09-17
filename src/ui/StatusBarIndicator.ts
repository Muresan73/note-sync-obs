import type { SyncStatus } from "../sync/SyncEngine";

/**
 * Status bar indicator. Obsidian calls the factory once; we keep a handle to
 * the element and update text on status events. Icon/text are plain ASCII so
 * they render in every theme.
 */
export class StatusBarIndicator {
	private el: HTMLElement | null = null;
	private status: SyncStatus | null = null;

	constructor(private readonly factory: () => HTMLElement) {}

	/** Attach to Obsidian's status bar (call once from onload). */
	attach(): void {
		this.el = this.factory();
		this.render();
	}

	update(status: SyncStatus): void {
		this.status = status;
		this.render();
	}

	private render(): void {
		if (!this.el) return;
		// Obsidian augments HTMLElement with setText; fall back to textContent.
		const set = (t: string) => {
			if (typeof (this.el as unknown as { setText?: (s: string) => void }).setText === "function") {
				(this.el as unknown as { setText: (s: string) => void }).setText(t);
			} else {
				this.el!.textContent = t;
			}
		};
		if (!this.status || this.status.state === "offline") {
			set("AM: off");
			return;
		}
		switch (this.status.state) {
			case "connecting":
				set("AM: connecting…");
				break;
			case "syncing":
				set("AM: syncing…");
				break;
			case "synced": {
				const ago =
					this.status.lastSyncMs === null ? "" : ` (${Math.round((Date.now() - this.status.lastSyncMs) / 1000)}s ago)`;
				set(`AM: ok ${this.status.filesSynced} files${ago}`);
				break;
			}
			case "error":
				set("AM: error");
				this.el.setAttribute("aria-label", this.status.error ?? "sync error");
				break;
			default:
				set("AM: ?"); // unknown state — should never happen
		}
	}

	detach(): void {
		this.el?.remove();
		this.el = null;
	}
}
