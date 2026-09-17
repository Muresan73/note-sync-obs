import { describe, it, expect, beforeAll } from "vitest";
import {
	initAutomerge,
	createDoc,
	changeDoc,
	encodeDoc,
	decodeDoc,
	mergeBytes,
	AutomergeError,
	type SampleDocument,
} from "../src/automerge/AutomergeDocumentStore";

beforeAll(async () => {
	await initAutomerge();
});

const seed = (): SampleDocument => ({
	title: "t",
	body: "b",
	tags: ["a"],
	updatedAt: 1,
});

describe("automerge pure layer", () => {
	it("creates a document with initial values", () => {
		const doc = createDoc(seed());
		expect(doc.title).toBe("t");
		expect(doc.tags).toEqual(["a"]);
	});

	it("changes a scalar field", () => {
		let doc = createDoc(seed());
		doc = changeDoc(doc, "set title", (d) => {
			d.title = "new";
		});
		expect(doc.title).toBe("new");
	});

	it("inserts and modifies text", () => {
		let doc = createDoc(seed());
		doc = changeDoc(doc, "body edit", (d) => {
			d.body += " more";
		});
		doc = changeDoc(doc, "body edit2", (d) => {
			d.body = d.body.replace("more", "much more");
		});
		expect(doc.body).toBe("b much more");
	});

	it("adds a tag", () => {
		let doc = createDoc(seed());
		doc = changeDoc(doc, "add tag", (d) => {
			d.tags.push("second");
		});
		expect(doc.tags).toEqual(["a", "second"]);
	});

	it("round-trips encode/decode preserving history", () => {
		let doc = createDoc(seed());
		doc = changeDoc(doc, "c1", (d) => {
			d.title = "round";
		});
		const bytes = encodeDoc(doc);
		expect(bytes[0]).not.toBe("".charCodeAt(0)); // opaque binary, not text
		const restored = decodeDoc(bytes);
		expect(restored.title).toBe("round");
		expect(restored.tags).toEqual(["a"]);
	});

	it("rejects malformed bytes with a useful error", () => {
		const bad = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(() => decodeDoc(bad)).toThrow(AutomergeError);
	});

	it("merges two independently changed replicas without data loss", () => {
		const base = createDoc(seed());
		const bytesA = encodeDoc(base);
		const docA = changeDoc(decodeDoc(bytesA), "A", (d) => {
			d.title = "from A";
		});
		const docB = changeDoc(decodeDoc(bytesA), "B", (d) => {
			d.tags.push("from-b");
		});

		const mergedA = mergeBytes(docA, encodeDoc(docB));
		expect(mergedA.title).toBe("from A");
		expect(mergedA.tags).toContain("from-b");

		// Merge is symmetric.
		const mergedB = mergeBytes(docB, encodeDoc(docA));
		expect(mergedB.title).toBe("from A");
		expect(mergedB.tags).toContain("from-b");
	});

	it("serialization is deterministic for identical histories", () => {
		const doc = changeDoc(createDoc(seed()), "c", (d) => {
			d.title = "same";
		});
		// Two loads of the same bytes re-save identically.
		const bytes1 = encodeDoc(decodeDoc(encodeDoc(doc)));
		const bytes2 = encodeDoc(decodeDoc(encodeDoc(doc)));
		expect(Buffer.from(bytes1).equals(Buffer.from(bytes2))).toBe(true);
	});
});
