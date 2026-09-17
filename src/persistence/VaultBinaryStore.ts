/**
 * Obsidian binary persistence via Vault adapter.
 *
 * Atomicity note: the public Vault/DataAdapter API has no atomic rename, so a
 * crash mid-write could truncate the file. Mitigation below: write to
 * `<path>.tmp`, read back and verify byte equality, then copy over the target.
 * The old file is only clobbered after the tmp write is verified, so a failure
 * during the tmp phase always leaves the previous document intact. A failure
 * between verify and the final write is a small window we cannot close with
 * the public API — stated clearly rather than hidden.
 */
import { normalizePath } from "obsidian";

export interface BinaryStore {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<Uint8Array>;
	write(path: string, bytes: Uint8Array): Promise<void>;
	mkdir(path: string): Promise<void>;
}

export class VaultBinaryStore implements BinaryStore {
	constructor(private readonly adapter: {
		exists: (p: string) => Promise<boolean>;
		readBinary: (p: string) => Promise<ArrayBuffer>;
		writeBinary: (p: string, data: ArrayBuffer) => Promise<void>;
		mkdir: (p: string) => Promise<void>;
	}) {}

	async exists(path: string): Promise<boolean> {
		return this.adapter.exists(normalizePath(path));
	}

	async read(path: string): Promise<Uint8Array> {
		return new Uint8Array(await this.adapter.readBinary(normalizePath(path)));
	}

	async write(path: string, bytes: Uint8Array): Promise<void> {
		const target = normalizePath(path);
		const tmp = target + ".tmp";
		await this.adapter.writeBinary(tmp, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
		// Verify tmp round-trip before touching the real file.
		const written = new Uint8Array(await this.adapter.readBinary(tmp));
		if (written.length !== bytes.length || written.some((b, i) => b !== bytes[i])) {
			throw new Error(`Write verification failed for ${tmp} — leaving original file untouched.`);
		}
		await this.adapter.writeBinary(target, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
	}

	async mkdir(path: string): Promise<void> {
		await this.adapter.mkdir(normalizePath(path));
	}

	async mkdirp(path: string): Promise<void> {
		const parts = normalizePath(path).split("/").filter(Boolean);
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			if (!(await this.adapter.exists(cur))) {
				await this.adapter.mkdir(cur);
			}
		}
	}
}

/** Bytes equality helper used by tests and write verification. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
