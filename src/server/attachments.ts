/**
 * Attachments: bytes that cross between a connector and mason as a content id, never as base64 in a JSON frame.
 *
 * A shared filesystem path is not a remote protocol, and a 25 MB image is not a JSON-RPC message. So the connector
 * uploads to its own authenticated endpoint, gets an id back, and references that id in a submission's `file` block;
 * mason reads the bytes from its own store when it needs them, and a connector downloading an id gets back only what it
 * itself uploaded.
 *
 * The store is a directory per connector under the home's `data/`, with one file of bytes and one of metadata:
 *
 * ```text
 * service/data/attachments/<connector>/<contentId>          # the bytes
 * service/data/attachments/<connector>/<contentId>.json     # type, name, size, expiry
 * ```
 *
 * It is durable on purpose. A restart between the upload and the submission that references it is exactly the moment a
 * resend happens, and an id that died with the process would turn a redelivery into a lost photograph.
 *
 * Everything here is scoped by connector and checked on the way out: an id that is not `cnt_<hex>` never reaches the
 * filesystem, an id another connector uploaded answers `404` (not `403` — which ids exist is not a sender's business),
 * an expired one answers `410`, and one over the cap is refused before it is stored.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The protocol's default cap: enough for a phone video, far below what a sender may buffer into a socket. */
export const ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** A day: long enough for a message to be read and answered, short enough that a home does not fill with files. */
export const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

/** One upload a minute more than a submission, because a message with three photographs is one message. */
export const ATTACHMENT_LIMIT = 30;

const CONTENT_ID = /^cnt_[0-9a-f]{32}$/;

export interface AttachmentMeta {
	readonly contentId: string;
	readonly connector: string;
	readonly size: number;
	readonly mimeType: string;
	readonly name?: string;
	readonly createdAt: number;
	readonly expiresAt: number;
}

export interface StoredAttachment {
	readonly meta: AttachmentMeta;
	readonly bytes: Buffer;
}

export type AttachmentRead =
	| { readonly status: "ok"; readonly attachment: StoredAttachment }
	| { readonly status: "missing" }
	| { readonly status: "expired" };

export class AttachmentStore {
	readonly #root: string;
	readonly #now: () => number;
	readonly #ttlMs: number;
	readonly #maxBytes: number;

	constructor(options: {
		/** The home's `data/`: `attachments/` is created below it. */
		readonly dataDir: string;
		readonly now?: () => number;
		readonly ttlMs?: number;
		readonly maxBytes?: number;
	}) {
		this.#root = join(options.dataDir, "attachments");
		this.#now = options.now ?? Date.now;
		this.#ttlMs = options.ttlMs ?? ATTACHMENT_TTL_MS;
		this.#maxBytes = options.maxBytes ?? ATTACHMENT_BYTES;
	}

	get maxBytes(): number {
		return this.#maxBytes;
	}

	get ttlMs(): number {
		return this.#ttlMs;
	}

	/**
	 * Store one upload and answer the id to reference it by.
	 *
	 * `undefined` above the cap: the caller answers `413` and nothing is written. Expired files of this connector are
	 * swept on the way in, so the store is bounded by traffic rather than by a timer nobody would remember to run.
	 */
	async save(
		connector: string,
		bytes: Buffer,
		meta: { readonly mimeType?: string; readonly name?: string },
	): Promise<AttachmentMeta | undefined> {
		if (bytes.byteLength > this.#maxBytes) return undefined;
		const directory = this.#directory(connector);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await this.#sweep(directory);
		const contentId = `cnt_${randomBytes(16).toString("hex")}`;
		const now = this.#now();
		const record: AttachmentMeta = {
			contentId,
			connector,
			size: bytes.byteLength,
			mimeType: meta.mimeType === undefined || meta.mimeType === "" ? "application/octet-stream" : meta.mimeType,
			...(meta.name === undefined || meta.name === "" ? {} : { name: meta.name }),
			createdAt: now,
			expiresAt: now + this.#ttlMs,
		};
		await writeFile(join(directory, contentId), bytes, { mode: 0o600 });
		await writeFile(join(directory, `${contentId}.json`), JSON.stringify(record), { mode: 0o600 });
		return record;
	}

	/**
	 * The bytes behind one id, as this connector may see them.
	 *
	 * A malformed id, an id this connector never uploaded and an id whose files are gone all answer `missing`: telling a
	 * sender that another connector owns an id would confirm the id exists.
	 */
	async read(connector: string, contentId: string): Promise<AttachmentRead> {
		if (!CONTENT_ID.test(contentId)) return { status: "missing" };
		const directory = this.#directory(connector);
		let meta: AttachmentMeta;
		try {
			const parsed: unknown = JSON.parse(await readFile(join(directory, `${contentId}.json`), "utf8"));
			if (!isMeta(parsed) || parsed.connector !== connector || parsed.contentId !== contentId) {
				return { status: "missing" };
			}
			meta = parsed;
		} catch {
			return { status: "missing" };
		}
		if (meta.expiresAt <= this.#now()) return { status: "expired" };
		try {
			const bytes = await readFile(join(directory, contentId));
			return { status: "ok", attachment: { meta, bytes } };
		} catch {
			return { status: "missing" };
		}
	}

	/** The directory one connector's files live in, created on demand. A connector name is already validated as a name. */
	#directory(connector: string): string {
		return join(this.#root, connector);
	}

	/** Delete this connector's expired files. Best effort: a file that cannot be removed is one the next sweep tries again. */
	async #sweep(directory: string): Promise<void> {
		let names: string[];
		try {
			names = await readdir(directory);
		} catch {
			return;
		}
		const now = this.#now();
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const path = join(directory, name);
			try {
				const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
				if (!isMeta(parsed) || parsed.expiresAt > now) continue;
				await rm(join(directory, parsed.contentId), { force: true });
				await rm(path, { force: true });
			} catch {
				// An unreadable sidecar is not a reason to fail an upload; it is swept next time, or never.
			}
		}
	}
}

function isMeta(value: unknown): value is AttachmentMeta {
	if (typeof value !== "object" || value === null) return false;
	const meta = value as Record<string, unknown>;
	return (
		typeof meta.contentId === "string" &&
		typeof meta.connector === "string" &&
		typeof meta.size === "number" &&
		typeof meta.mimeType === "string" &&
		typeof meta.createdAt === "number" &&
		typeof meta.expiresAt === "number" &&
		(meta.name === undefined || typeof meta.name === "string")
	);
}
