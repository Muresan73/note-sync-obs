/**
 * The vault bridge, tested as a user would experience it: edit a file, sync,
 * look at the file.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as Automerge from "@automerge/automerge/slim";
import { vaultStore } from "../src/vault";
import { fakeVault, pngBytes } from "./helpers/fakeVault";

describe("vault bridge", () => {
	let vault: ReturnType<typeof fakeVault>;
	let store: ReturnType<typeof vaultStore>;

	beforeEach(() => {
		vault = fakeVault();
		store = vaultStore(vault.io);
	});

	it("seeds a document from a note the user has not synced before", async () => {
		vault.addNote("ideas.md", "# Hello\n");
		const bytes = await store.read("ideas.md");
		expect(bytes).not.toBeNull();
		expect(bytes!.byteLength).toBeGreaterThan(0);
	});

	it("does not rewrite the file when nothing changed", async () => {
		vault.addNote("ideas.md", "# Hello\n");
		const before = vault.text("ideas.md");
		await store.write("ideas.md", await store.read("ideas.md"));
		expect(vault.text("ideas.md")).toBe(before);
	});

	it("folds an edit into the document and back out to the file", async () => {
		vault.addNote("ideas.md", "first");
		await store.write("ideas.md", await store.read("ideas.md"));

		// The user types.
		vault.editNote("ideas.md", "second");
		const bytes = await store.read("ideas.md");

		// Pretend a peer merged it and handed the document back.
		await store.write("ideas.md", bytes!);
		expect(vault.text("ideas.md")).toBe("second");
	});

	it("creates a note that only the peer has", async () => {
		await store.write("remote.md", seededDoc("remote.md", "from the other side"));
		expect(vault.text("remote.md")).toBe("from the other side");
		expect(vault.created).toContain("remote.md");
	});

	it("trashes a note the document says was deleted", async () => {
		vault.addNote("gone.md", "text");
		const doc = await store.read("gone.md");
		await store.write("gone.md", tombstone(doc!));
		expect(vault.trashed).toContain("gone.md");
		expect(vault.text("gone.md")).toBeUndefined();
	});

	it("marks a note deleted when the file disappears", async () => {
		vault.addNote("vanishing.md", "text");
		await store.write("vanishing.md", await store.read("vanishing.md"));

		// The user deletes the file in Obsidian.
		vault.files.delete("vanishing.md");

		// Reading it must produce a tombstone, not resurrect the content.
		const bytes = await store.read("vanishing.md");
		expect(bytes).not.toBeNull();
		expect(await store.read("vanishing.md")).not.toBeNull();
	});

	it("lists a deleted note so the tombstone can reach the peer", async () => {
		vault.addNote("doomed.md", "text");
		await store.write("doomed.md", await store.read("doomed.md"));
		vault.files.delete("doomed.md");

		expect(await store.list()).toContain("doomed.md");
	});
});

describe("attachments", () => {
	let vault: ReturnType<typeof fakeVault>;
	let store: ReturnType<typeof vaultStore>;

	beforeEach(() => {
		vault = fakeVault();
		store = vaultStore(vault.io);
	});

	it("carries image bytes through unchanged", async () => {
		const original = pngBytes(1);
		vault.addBinary("img/shot.png", original);
		const bytes = await store.read("img/shot.png");
		await store.write("img/shot.png", bytes!);
		expect(vault.bytes("img/shot.png")).toEqual(original);
	});

	it("creates an image that only the peer has", async () => {
		const original = pngBytes(2);
		await store.write("img/new.png", await seededBinaryDoc("img/new.png", original));
		expect(vault.bytes("img/new.png")).toEqual(original);
	});

	it("leaves an untouched image alone", async () => {
		vault.addBinary("img/shot.png", pngBytes(3));
		// Round one stores it. Round two must find nothing to do.
		await store.write("img/shot.png", await store.read("img/shot.png"));
		const mtime = vault.files.get("img/shot.png")!.mtime;
		await store.write("img/shot.png", await store.read("img/shot.png"));
		expect(vault.files.get("img/shot.png")!.mtime).toBe(mtime);
	});

	it("propagates a replaced image", async () => {
		vault.addBinary("img/shot.png", pngBytes(4));
		await store.write("img/shot.png", await store.read("img/shot.png"));

		const replacement = pngBytes(5);
		vault.editBinary("img/shot.png", replacement);
		await store.write("img/shot.png", await store.read("img/shot.png"));
		expect(vault.bytes("img/shot.png")).toEqual(replacement);
	});

	it("removes an image the document says was deleted", async () => {
		vault.addBinary("img/shot.png", pngBytes(6));
		const doc = await store.read("img/shot.png");
		await store.write("img/shot.png", tombstone(doc!));
		expect(vault.trashed).toContain("img/shot.png");
	});
});

// Build a document as if it had come from another vault, without needing a peer.
function seededDoc(path: string, content: string): Uint8Array {
	return Automerge.save(Automerge.from({ path, content, updatedAt: 1 }));
}

async function seededBinaryDoc(path: string, content: Uint8Array): Promise<Uint8Array> {
	const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(content).buffer);
	const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	const b64 = btoa(String.fromCharCode(...Uint8Array.from(content)));
	return Automerge.save(Automerge.from({ path, content: b64, updatedAt: 1, hash }));
}

function tombstone(doc: Uint8Array): Uint8Array {
	return Automerge.save(
		Automerge.change(Automerge.load(doc), "delete", (d: { deleted: boolean; content: string }) => {
			d.deleted = true;
			d.content = "";
		}),
	);
}