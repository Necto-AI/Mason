/**
 * The other direction of the inbox: a file the agent wrote there, made ready to send, or refused in a sentence it reads.
 *
 * `src/inbox.ts` is why this file exists in the same shape. A payload carries a path because a path is what `read` opens,
 * and the volume is shared at one path in both containers. The same volume is therefore the only place a file can come
 * from when it goes the other way: the relay may read one directory of the agent's home, which is what keeps it from
 * reading the profile, the log, the skills and the memory repository. A path that is not in there is refused, and the
 * refusal says what to do instead rather than what went wrong.
 *
 * Four decisions:
 *
 * - **The resolved path is what counts, and the separator is what makes it a directory.** `realpath` collapses `..` and
 *   follows symlinks, so a link inside the inbox that points outside it resolves outside it and is refused; the prefix
 *   comparison appends the separator, so `/a/inbox-evil` is not `/a/inbox`. Nothing here trusts the string the model wrote.
 * - **A refusal is the tool's answer, not an exception.** A missing file, a directory, a file over the cap and a caption
 *   over Telegram's limit are all things the model can fix in its next call: each is one sentence naming the number or the
 *   path, and a cut instead of a refusal would be a message that says something the agent did not write.
 * - **The caps are Telegram's own.** 10 MiB for a photo and 50 MiB for a document, from the Bot API, and the extension
 *   picks which: the bytes are never sniffed, because the file's name is all this side knows before it reads them.
 * - **The name the chat sees is the inbox's own rule.** `safeName` is shared with the writing direction, because a name
 *   that arrives in a chat is a header: one segment, no control characters, no leading dot, no trailing `.part`.
 */
import type { Stats } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { safeName } from "./inbox.ts";
import { describeError } from "./log.ts";
import type { UploadKind } from "./telegram.ts";

/** Telegram's cap on a photo sent with `sendPhoto`, in MiB. Not a preference: over it is an error answer. */
export const MAX_PHOTO_MIB = 10;
/** The same cap for a document sent with `sendDocument`. */
export const MAX_DOCUMENT_MIB = 50;
/** The longest caption Telegram takes, in characters. A longer one is refused rather than cut. */
export const MAX_CAPTION = 1024;

/**
 * The extensions Telegram renders in the chat. Everything else is a document, and a document is a download: the same file
 * under another name is a worse-looking message, not a failed one.
 */
const PHOTO_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export interface SendFileRequest {
	/** The inbox's own path, the one directory this container may send from. */
	readonly dir: string;
	/** What the model named: absolute, and inside `dir` once every symlink and `..` is resolved. */
	readonly path: string;
	readonly caption?: string;
}

/** A file that passed every check, with the bytes read once: what goes on the wire and what the chat will show. */
export interface OutgoingFile {
	/** The name the chat sees, made safe by the inbox's own rule. */
	readonly name: string;
	readonly kind: UploadKind;
	readonly bytes: Uint8Array;
}

/**
 * What one request came to. A refusal is not an exception, because the model is the reader: it can name another path, a
 * shorter caption, or write the file first, and it can only do that if the answer says which.
 */
export type PreparedFile =
	| { readonly kind: "ready"; readonly file: OutgoingFile }
	| { readonly kind: "refused"; readonly reason: string };

/**
 * Everything that decides whether a named path may be sent, and then the read itself. The only caller is the tool, and
 * the only reason the bytes are read here rather than in the tool is that every refusal has to happen before a read of a
 * file that may not be sent.
 */
export async function prepareSendFile(request: SendFileRequest): Promise<PreparedFile> {
	if (!isAbsolute(request.path)) {
		return refuse(`the path must be absolute and inside the inbox at ${request.dir}; write the file into the inbox first`);
	}
	// The directory is resolved too: a home that is itself a symlink is ordinary, and comparing a resolved path against an
	// unresolved root would refuse every file in it. A root that does not exist yet is compared as it was written, because
	// the file below is about to be refused for not being in it either way.
	const root = await realpath(request.dir).catch(() => resolve(request.dir));
	let target: string;
	try {
		target = await realpath(request.path);
	} catch (error) {
		if (codeOf(error) === "ENOENT") {
			return refuse(`there is no file at ${request.path}; write it into the inbox at ${root} first`);
		}
		return refuse(`${request.path} could not be resolved: ${describeError(error)}`);
	}
	if (!isInside(target, root)) {
		return refuse(`${request.path} is outside the inbox at ${root}, the only directory a file may be sent from; write the file into the inbox first`);
	}
	// A name is what the chat shows, so the message about the file uses the same one the send would.
	const name = safeName(target);
	let info: Stats;
	try {
		info = await stat(target);
	} catch (error) {
		return codeOf(error) === "ENOENT"
			? refuse(`there is no file at ${request.path}; write it into the inbox first`)
			: refuse(`${name} could not be inspected: ${describeError(error)}`);
	}
	if (info.isDirectory()) return refuse(`${name} is a directory, and only a file can be sent`);
	if (!info.isFile()) return refuse(`${name} is not a regular file, and only a file can be sent`);
	const kind = kindOf(target);
	const limit = kind === "photo" ? MAX_PHOTO_MIB : MAX_DOCUMENT_MIB;
	if (info.size > limit * 1024 * 1024) {
		return refuse(`${name} is ${sizeInMib(info.size)}, and Telegram sends at most ${limit} MiB as a ${kind}`);
	}
	if (request.caption !== undefined && request.caption.length > MAX_CAPTION) {
		return refuse(`the caption is ${request.caption.length} characters, and Telegram takes at most ${MAX_CAPTION}`);
	}
	try {
		return { kind: "ready", file: { name, kind, bytes: await readFile(target) } };
	} catch (error) {
		return refuse(`${name} could not be read: ${describeError(error)}`);
	}
}

/** Photo or document, from the extension alone. The model writes a name; that name is the whole of the evidence here. */
function kindOf(path: string): UploadKind {
	return PHOTO_EXTENSIONS.has(extname(path).toLowerCase()) ? "photo" : "document";
}

/**
 * Whether `path` is in the directory `root`. The appended separator is the check: `/a/inbox-evil` starts with `/a/inbox`
 * and is not in it, and `root` ending in a separator is a root that is already the whole prefix.
 */
function isInside(path: string, root: string): boolean {
	return path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** A size in MiB, rounded up to two decimals: a byte over the cap never reads as the cap itself. */
function sizeInMib(bytes: number): string {
	return `${Math.ceil((bytes / (1024 * 1024)) * 100) / 100} MiB`;
}

function codeOf(error: unknown): unknown {
	return (error as { code?: unknown } | null)?.code;
}

function refuse(reason: string): PreparedFile {
	return { kind: "refused", reason };
}
