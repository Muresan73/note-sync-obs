import type { Plugin } from "obsidian";
import { AutomergeDocumentStore, type SampleDocument, createDoc, encodeDoc } from "../automerge/AutomergeDocumentStore";

export const SAMPLE_PATH = ".automerge-sync/sample.automerge";

/**
 * Build the initial sample document. Kept as a factory so tests and the
 * command share the same seed content.
 */
export function sampleSeed(): SampleDocument {
	return {
		title: "Automerge sample",
		body: "Created by the automerge-sync plugin.",
		tags: ["automerge", "local-first"],
		updatedAt: Date.now(),
	};
}

/**
 * Create-or-update: if the document exists, mutate it through the service
 * (never raw bytes); otherwise create it.
 */
export async function createOrUpdateSample(
	store: AutomergeDocumentStore,
	plugin: Pick<Plugin, "manifest">,
): Promise<SampleDocument> {
	if (await store.exists()) {
		return store.change((d) => {
			d.body = `Updated at ${new Date().toLocaleString()} (plugin ${plugin.manifest.version})`;
			d.updatedAt = Date.now();
		}, "sample update");
	}
	return store.create(sampleSeed());
}

export { encodeDoc, createDoc };
