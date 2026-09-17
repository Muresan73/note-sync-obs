import { Plugin, Notice } from "obsidian";
import { VaultBinaryStore } from "./persistence/VaultBinaryStore";
import {
	AutomergeDocumentStore,
	AutomergeError,
	initAutomerge,
	decodeDoc,
	type SampleDocument,
} from "./automerge/AutomergeDocumentStore";
import { createOrUpdateSample, SAMPLE_PATH } from "./commands/sampleDocument";
import { DocumentModal } from "./ui/DocumentView";

export default class AutomergeSyncPlugin extends Plugin {
	private store!: AutomergeDocumentService;

	// Alias to keep naming clear; the service wraps store+persistence.
	private readonly docServiceGetter = () => this.store;

	/** Exposed for tests. */
	get documentService(): AutomergeDocumentService {
		return this.store;
	}

	async onload(): Promise<void> {
		// Await WASM-backed Automerge init before registering commands.
		await initAutomerge();

		const binaryStore = new VaultBinaryStore(this.app.vault.adapter);
		await binaryStore.mkdirp(".automerge-sync");
		const service = new AutomergeDocumentService(
			new AutomergeDocumentStore(binaryStore, SAMPLE_PATH),
		);
		this.store = service;

		this.addCommand({
			id: "create-or-update-sample",
			name: "Create or update Automerge sample document",
			callback: async () => {
				try {
					const doc = await createOrUpdateSample(service.raw(), this);
					new Notice(`Automerge sample document saved (${doc.tags.length} tags).`);
				} catch (e) {
					this.reportFailure("Failed to create/update sample document", e);
				}
			},
		});

		this.addCommand({
			id: "show-sample",
			name: "Show Automerge sample document",
			callback: async () => {
				try {
					const doc = await service.raw().load();
					new DocumentModal(this.app, doc).open();
				} catch (e) {
					this.reportFailure("Failed to load sample document", e);
				}
			},
		});

		this.addCommand({
			id: "inspect-bytes",
			name: "Show raw Automerge byte length",
			callback: async () => {
				try {
					const bytes = await this.app.vault.adapter.readBinary(SAMPLE_PATH);
					new Notice(`sample.automerge is ${bytes.byteLength} bytes.`);
				} catch (e) {
					this.reportFailure("Failed to read document bytes", e);
				}
			},
		});
	}

	onunload(): void {
		// Nothing persistent to release: no workers, no intervals, no DOM
		// outside Obsidian-managed modals. Kept as an explicit hook so future
		// sync/network layers have a cleanup point.
	}

	private reportFailure(message: string, error: unknown): void {
		new Notice(`${message}: ${error instanceof Error ? error.message : String(error)}`);
		if (error instanceof AutomergeError && error.cause) {
			console.error("[automerge-sync] underlying cause:", error.cause);
		} else {
			console.error("[automerge-sync]", error);
		}
	}
}

/**
 * Facade the commands use; swallows nothing, just gives commands a stable
 * surface and keeps raw store access internal-ish.
 */
export class AutomergeDocumentService {
	constructor(private readonly store: AutomergeDocumentStore) {}

	raw(): AutomergeDocumentStore {
		return this.store;
	}

	async loadValidated(): Promise<SampleDocument> {
		const doc = await this.store.load();
		validateShape(doc);
		return doc;
	}
}

/** Runtime shape validation for data loaded from disk. */
export function validateShape(doc: SampleDocument): void {
	const problems: string[] = [];
	if (typeof doc.title !== "string") problems.push("title must be a string");
	if (typeof doc.body !== "string") problems.push("body must be a string");
	if (!Array.isArray(doc.tags) || !doc.tags.every((t) => typeof t === "string")) {
		problems.push("tags must be string[]");
	}
	if (typeof doc.updatedAt !== "number") problems.push("updatedAt must be a number");
	if (problems.length) {
		throw new AutomergeError(`Document failed schema validation: ${problems.join("; ")}`);
	}
}

export { decodeDoc };
