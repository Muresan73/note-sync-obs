import * as Automerge from "@automerge/automerge/slim";
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64";

/**
 * Types for our sample document schema stored in Automerge.
 * Automerge handles runtime shape internally; we do our own validation on load.
 */

export type SampleDocument = {
	title: string;
	body: string;
	tags: string[];
	updatedAt: number;
};

const DOC_PATH = ".automerge-sync/sample.automerge";

export class AutomergeError extends Error {
	constructor(message: string, public readonly cause?: unknown) {
		super(message);
		this.name = "AutomergeError";
	}
}

/**
 * Adapter for loading/initializing Automerge. We use the /slim entry point
 * plus the base64-encoded WASM blob — Automerge's documented path for
 * environments where only JS files can be loaded (Obsidian plugins).
 * Initialization must happen exactly once, before any other API use.
 */
let initPromise: Promise<void> | null = null;
export async function initAutomerge(): Promise<void> {
	if (!initPromise) {
		initPromise = Automerge.initializeBase64Wasm(automergeWasmBase64);
	}
	await initPromise;
}

/** Encode an Automerge doc to opaque binary bytes. */
export function encodeDoc(doc: SampleDocument): Uint8Array {
	return Automerge.save(doc as unknown as Automerge.Doc<SampleDocument>);
}

/**
 * Decode Automerge bytes back into a document. Throws AutomergeError on
 * malformed bytes; callers must validate the resulting shape.
 */
export function decodeDoc(bytes: Uint8Array): SampleDocument {
	let doc: Automerge.Doc<SampleDocument>;
	try {
		doc = Automerge.load<SampleDocument>(bytes);
	} catch (e) {
		throw new AutomergeError(
			"Failed to load Automerge document from bytes — file may be corrupt or not an Automerge document.",
			e,
		);
	}
	return doc as SampleDocument;
}

/** Create a fresh Automerge document from an initial value. */
export function createDoc(initial: SampleDocument): SampleDocument {
	return Automerge.from(initial) as unknown as SampleDocument;
}

/**
 * Apply a typed mutation to the document, returning a new immutable doc handle.
 * `mutator` receives the document and should not reassign it.
 */
export function changeDoc(
	doc: SampleDocument,
	message: string,
	mutator: (d: SampleDocument) => void,
): SampleDocument {
	return Automerge.change(doc as unknown as Automerge.Doc<SampleDocument>, message, mutator) as unknown as SampleDocument;
}

/**
 * Merge another replica's bytes into this document and return the combined doc.
 * Automerge merge is a CRDT merge: concurrent changes on both sides survive.
 */
export function mergeBytes(local: SampleDocument, otherBytes: Uint8Array): SampleDocument {
	let other: SampleDocument;
	try {
		other = decodeDoc(otherBytes);
	} catch (e) {
		throw new AutomergeError("Merge failed: remote bytes are not a valid Automerge document.", e);
	}
	return Automerge.merge(
		local as unknown as Automerge.Doc<SampleDocument>,
		other as unknown as Automerge.Doc<SampleDocument>,
	) as unknown as SampleDocument;
}

/**
 * The document store. Owns the file path and coordinates encode/decode plus
 * persistence. `T` is constrained to the sample shape for this milestone but
 * the class itself is generic-friendly.
 */
export class AutomergeDocumentStore {
	readonly path: string;

	constructor(
		private readonly store: {
			exists(path: string): Promise<boolean>;
			read(path: string): Promise<Uint8Array>;
			write(path: string, bytes: Uint8Array): Promise<void>;
			mkdir(path: string): Promise<void>;
		},
		path: string = DOC_PATH,
	) {
		this.path = path;
	}

	async exists(): Promise<boolean> {
		return this.store.exists(this.path);
	}

	async load(): Promise<SampleDocument> {
		const bytes = await this.store.read(this.path);
		return decodeDoc(bytes);
	}

	async save(doc: SampleDocument): Promise<void> {
		const bytes = encodeDoc(doc);
		await this.store.write(this.path, bytes);
	}

	async create(initial: SampleDocument): Promise<SampleDocument> {
		const doc = createDoc(initial);
		await this.save(doc);
		return doc;
	}

	async change(
		mutator: (d: SampleDocument) => void,
		message = "plugin change",
	): Promise<SampleDocument> {
		const current = await this.load();
		const next = changeDoc(current, message, mutator);
		await this.save(next);
		return next;
	}

	async merge(otherBytes: Uint8Array): Promise<SampleDocument> {
		const current = await this.load();
		const merged = mergeBytes(current, otherBytes);
		await this.save(merged);
		return merged;
	}
}
