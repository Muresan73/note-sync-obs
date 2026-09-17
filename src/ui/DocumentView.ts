import { Modal, type App } from "obsidian";
import type { SampleDocument } from "../automerge/AutomergeDocumentStore";

/**
 * Simple modal that renders the document with escaping — no innerHTML of
 * document content, no Notice for large payloads.
 */
export class DocumentModal extends Modal {
	constructor(
		app: App,
		private readonly doc: SampleDocument,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Automerge sample document" });
		contentEl.createEl("p", { text: `Title: ${this.doc.title}` });
		contentEl.createEl("p", { text: `Updated: ${new Date(this.doc.updatedAt).toLocaleString()}` });
		contentEl.createEl("p", { text: `Tags: ${this.doc.tags.join(", ")}` });
		const body = contentEl.createEl("pre");
		body.setText(this.doc.body); // setText escapes content
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
