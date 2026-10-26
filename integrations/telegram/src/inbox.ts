/**
 * Where an incoming file lands: the one directory this container writes, which is also a directory the agent's tool
 * machine reads.
 *
 * A payload is a string, so a file reaches the agent as a path. That path has to mean the same thing in both containers —
 * this one mounts `mason-inbox` at `/home/mason/.mason/agent/workspace/inbox`, and `mason-env` mounts the same volume at
 * the same path — so the agent's `read` opens exactly the bytes written here, and a photo comes back as an image rather
 * than as something it cannot open. It is a volume of its own rather than `mason-agent`, because a relay has no business
 * reading the profile, the log, the skills or the memory repository: one directory is the whole of what it shares.
 *
 * Four decisions:
 *
 * - **Telegram's own download cap is the cap.** A bot may fetch 20 MiB through `getFile`, and anything larger is refused
 *   by Telegram anyway; refusing it here first means a reason a person can read instead of a download failing halfway.
 *   Telegram does not always say how large a file is (a voice note carries no size), so the bytes are checked too — before
 *   a single one reaches the volume.
 * - **The name is the sender's, made safe.** `<update_id>-` is what makes it unique: an update id is monotonic per bot, so
 *   two files called `report.pdf` are two paths and the second never overwrites the first. What follows is the last path
 *   segment of the sender's name with no leading dot, no control character, no trailing `.part` and a length cap, because
 *   it is written to a path and then printed into a payload.
 * - **A write is whole or absent.** The bytes go to `<name>.part` and are renamed over the target, the same idiom as
 *   `src/state.ts`: a crash mid-write leaves a `.part` nothing points at, never a plausible-looking attachment cut in
 *   half. Nothing is written at all when the fetch was refused.
 * - **Nothing is kept forever.** A sweep on write, and once at startup, deletes anything older than `RETENTION_MS`. The
 *   volume has no other watcher, and an inbox nothing claims would otherwise fill with files whose only reader was a
 *   message from a week ago.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventFile } from "./envelope.ts";
import type { Attachment } from "./filter.ts";
import { describeError, type Log } from "./log.ts";
import type { TelegramFile } from "./telegram.ts";

/** Telegram's cap on a file a bot may fetch through `getFile`, in MiB. */
export const MAX_FILE_MIB = 20;
/** The same cap in bytes: the comparison every refusal makes. */
export const MAX_FILE_BYTES = MAX_FILE_MIB * 1024 * 1024;
/** How long a file stays on the volume before a sweep takes it. */
export const RETENTION_DAYS = 7;
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1_000;
/**
 * How much the whole inbox may hold, and the ceiling that age alone cannot give. A week is not a bound on space: one
 * allowlisted chat can send twenty 20 MiB files a minute, which is 24 GiB an hour and 4 TiB a week. Age keeps the
 * directory tidy; this keeps it from filling the host's disk while it waits.
 */
export const INBOX_MAX_MIB = 512;
export const INBOX_MAX_BYTES = INBOX_MAX_MIB * 1024 * 1024;

/**
 * The longest name this writes, in **bytes**. A filesystem limit is a byte limit: 100 `slice`d characters of Cyrillic or
 * CJK is 200 to 300 bytes and `writeFile` refuses it with ENAMETOOLONG, so a perfectly ordinary name from a Russian
 * phone would have been an attachment that never arrived.
 */
const NAME_MAX_BYTES = 200;
/** What a name that sanitises to nothing at all is called. A name is never the whole of a path here. */
const FALLBACK_NAME = "file";

/**
 * What the inbox asks of Telegram: the two calls one download is. Narrow on purpose, like `UpdateSource` — a test scripts
 * them, and nothing here can reach the rest of the API.
 */
export interface FileSource {
	getFile(options: { readonly fileId: string }): Promise<TelegramFile>;
	downloadFile(options: { readonly filePath: string }): Promise<Uint8Array>;
}

export interface InboxOptions {
	readonly api: FileSource;
	/** The directory the payload's path names, in this container and in the tool machine alike. */
	readonly dir: string;
	readonly log: Log;
	/** The clock the retention is kept to, in milliseconds. Injected so a test can age a file without waiting a week. */
	readonly now?: () => number;
	/** The size ceiling, in bytes. Injected for the same reason: a test of a 512 MiB ceiling would write 512 MiB. */
	readonly maxBytes?: number;
}

/**
 * What one save came to. A refusal is not an exception: a file that is too large, or that Telegram will not hand over, is
 * a message the agent should still hear about, and the poller says so in one log line and delivers the text alone.
 */
export type SaveOutcome =
	| { readonly kind: "saved"; readonly file: EventFile }
	| { readonly kind: "refused"; readonly reason: string };

export class Inbox {
	readonly #api: FileSource;
	readonly #dir: string;
	readonly #log: Log;
	readonly #now: () => number;
	readonly #maxBytes: number;

	constructor(options: InboxOptions) {
		this.#api = options.api;
		this.#dir = options.dir;
		this.#log = options.log;
		this.#now = options.now ?? (() => Date.now());
		this.#maxBytes = options.maxBytes ?? INBOX_MAX_BYTES;
	}

	/**
	 * Fetch one attachment and write it. The only filesystem writer in this package, and the only caller of the two
	 * download calls.
	 */
	async save(attachment: Attachment, options: { readonly updateId: number }): Promise<SaveOutcome> {
		// Before the fetch, not after the write: a volume at its limit must be given room first, and a refused download
		// has cost nothing but the readdir.
		await this.sweep();
		let remote: TelegramFile;
		try {
			remote = await this.#api.getFile({ fileId: attachment.fileId });
		} catch (error) {
			return { kind: "refused", reason: `Telegram would not name it: ${describeError(error)}` };
		}
		const told = remote.fileSize ?? attachment.size;
		if (told !== undefined && told > MAX_FILE_BYTES) return tooLarge(told);
		let bytes: Uint8Array;
		try {
			bytes = await this.#api.downloadFile({ filePath: remote.filePath });
		} catch (error) {
			return { kind: "refused", reason: `the download failed: ${describeError(error)}` };
		}
		if (bytes.byteLength > MAX_FILE_BYTES) return tooLarge(bytes.byteLength);
		const name = `${options.updateId}-${safeName(attachment.name)}`;
		const path = join(this.#dir, name);
		const problem = await this.#write(path, bytes);
		if (problem !== undefined) return { kind: "refused", reason: problem };
		return { kind: "saved", file: { path, name, size: bytes.byteLength, kind: attachment.kind } };
	}

	/**
	 * Delete what nothing claimed. Never throws: a volume that fills is a message that cannot be delivered, while a sweep
	 * that failed is one line and the next write tries again.
	 */
	async sweep(): Promise<void> {
		const cutoff = this.#now() - RETENTION_MS;
		const entries = await readdir(this.#dir, { withFileTypes: true }).catch((error: unknown) => {
			// A directory that is not there yet is a first boot, not a failure: `save` creates it when it needs it.
			if ((error as { code?: unknown }).code !== "ENOENT") {
				this.#log("warn", `could not read the inbox at ${this.#dir}: ${describeError(error)}`);
			}
			return [];
		});
		let removed = 0;
		let reclaimed = 0;
		let problem: string | undefined;
		const survivors: { path: string; mtimeMs: number; size: number }[] = [];
		for (const entry of entries) {
			// A directory or a symlink somebody else put here is not this sweep's business, and following one is how a
			// delete becomes a delete somewhere else.
			if (!entry.isFile()) continue;
			const path = join(this.#dir, entry.name);
			try {
				const info = await stat(path);
				if (info.mtimeMs > cutoff) {
					survivors.push({ path, mtimeMs: info.mtimeMs, size: info.size });
					continue;
				}
				await unlink(path);
				removed += 1;
				reclaimed += info.size;
			} catch (error) {
				problem ??= `${path}: ${describeError(error)}`;
			}
		}
		// Then the size ceiling, oldest first: what the retention promises is that a file is gone after a week, and this
		// promises that the volume is not full before then. The newest file is kept even when it alone is over the ceiling,
		// because a sweep that deletes what was just written is a message that arrives and is gone.
		let total = survivors.reduce((sum, entry) => sum + entry.size, 0);
		if (total > this.#maxBytes) {
			survivors.sort((left, right) => left.mtimeMs - right.mtimeMs);
			for (const entry of survivors) {
				if (total <= this.#maxBytes) break;
				try {
					await unlink(entry.path);
					total -= entry.size;
					reclaimed += entry.size;
					removed += 1;
				} catch (error) {
					problem ??= `${entry.path}: ${describeError(error)}`;
				}
			}
		}
		if (problem !== undefined) {
			this.#log("warn", `the inbox sweep could not delete everything in ${this.#dir} (${problem})`);
		}
		if (removed > 0) {
			this.#log(
				"info",
				`the inbox sweep deleted ${removed} file(s) and ${Math.ceil(reclaimed / (1024 * 1024))} MiB from ${this.#dir}`,
			);
		}
	}

	/** The bytes at `path`, or why they are not: the failure a caller turns into a refusal. */
	async #write(path: string, bytes: Uint8Array): Promise<string | undefined> {
		// A random suffix, not `<name>.part`: the tool machine can write into this directory too, so a name it could
		// predict is a file it could pre-plant as a symlink for this write to follow somewhere else. `rename` does not
		// follow, and nothing but this call ever names the temporary.
		const temporary = `${path}.${randomUUID()}.part`;
		try {
			await mkdir(this.#dir, { recursive: true, mode: 0o700 });
			// `mode` applies to the file this creates, and 0600 has no bit a umask could add: only this container's user
			// reads what somebody sent.
			await writeFile(temporary, bytes, { mode: 0o600 });
			await rename(temporary, path);
			return undefined;
		} catch (error) {
			// The half-written file goes with the failure. A `.part` is swept by age anyway, but nothing left behind is
			// better than something a reader has to explain.
			await unlink(temporary).catch(() => {});
			return `could not write to ${this.#dir}: ${describeError(error)}`;
		}
	}
}

/** A file over Telegram's cap, in the sentence the poller logs. Rounded up, so a byte over the cap never reads as the cap. */
function tooLarge(bytes: number): SaveOutcome {
	const size = `${Math.ceil((bytes / (1024 * 1024)) * 10) / 10} MiB`;
	return { kind: "refused", reason: `it is ${size}, and a bot may download ${MAX_FILE_MIB} MiB` };
}

/**
 * The sender's name as a name on this volume: the last path segment of it, without control characters, without a leading
 * dot, without a trailing `.part` — which is what a write that never finished looks like — and no longer than
 * `NAME_MAX_BYTES`. A name that sanitises to nothing is `file`: a path is never allowed to end in a bare hyphen.
 */
function safeName(raw: string): string {
	const cleaned = (raw.split(/[/\\]/).at(-1) ?? "")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/^\.+/, "")
		.trim();
	// Cut by code point and by byte together: `slice` counts UTF-16 units, so it can end a name in half a surrogate pair
	// — which is a path in the payload that no file on disk has — and it counts characters where the filesystem counts
	// bytes.
	let cut = "";
	for (const character of cleaned) {
		if (Buffer.byteLength(cut + character, "utf8") > NAME_MAX_BYTES) break;
		cut += character;
	}
	const name = cut.replace(/\.part$/i, "").trim();
	return name === "" ? FALLBACK_NAME : name;
}
