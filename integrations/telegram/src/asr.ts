/**
 * A voice note, as words.
 *
 * Telegram hands the connector Ogg/Opus bytes and no tool the agent owns can read them, so a person's spoken message
 * reaches it as a path and a sentence and nothing else. This file is the one place that changes: when the container is
 * configured with a transcription endpoint, the bytes are posted there after they land on the inbox and before the event
 * is signed, and the event carries what was said beside the file it was said into.
 *
 * Six decisions:
 *
 * - **It is optional, and unset means unchanged.** An operator without a service gets exactly the payload this container
 *   sent before there was a setting: the sentence, the path, no transcript, no extra request.
 * - **Speech only, and only what is worth a round trip.** A voice note, an audio file and a round video note are the
 *   kinds a person spoke into; a photo, a PDF or a GIF is not. A file over `ASR_MAX_BYTES` is skipped before a byte is
 *   read, because the point of the cap is not to spend the request and the read on a recording.
 * - **A failure is a value, and the message is never lost.** A refused connection, a timeout, a `500`, a body that is not
 *   the promised shape, a file that is no longer where the inbox put it: each is one reason the caller turns into a
 *   sentence on the payload. Nothing here throws, so a service that is down costs a transcript rather than a message.
 * - **The answer is `{"text": "…"}`, and an empty text is an answer.** Plain text is read too, which is the shape this
 *   setting allowed from the start, but JSON is the contract mason's own service speaks. `{"text": ""}` means the clip
 *   was transcribed and there were no words in it — silence, a cough, a note recorded by accident — and that is a
 *   success, not a failure: calling it one would tell the agent something false about a person's message.
 * - **The bytes are the inbox file, exactly as it landed.** Nothing here re-encodes, resamples or rewraps: the file is
 *   read back from the path `src/inbox.ts` wrote and posted whole, and decoding audio is the service's side of the deal.
 * - **The URL is never printed whole.** A transcription endpoint is often a LAN address with a token in its path or
 *   query, so the only form of it that reaches a log line is its host.
 */
import { readFile } from "node:fs/promises";
import { ASR_MAX_BYTES, ASR_TEXT_MAX, ASR_TIMEOUT_MS } from "./constants.ts";
import type { EventFile } from "./envelope.ts";
import { describeError, formatDuration } from "./log.ts";
import type { Fetch, FileKind } from "./telegram.ts";

/** The kinds a person sent as speech. The only ones a transcription service is asked about. */
const SPEECH: ReadonlySet<FileKind> = new Set<FileKind>(["voice", "audio", "video_note"]);

/** Whether this kind is something somebody said. Exported so the poller asks the same question this file answers. */
export function isSpeech(kind: FileKind): boolean {
	return SPEECH.has(kind);
}

/**
 * What one transcription came to. A failure is `failed` rather than an exception: the caller keeps the file and says on
 * the payload that the words are missing, which is the half a person can act on. `silent` is the third answer and not a
 * failure — the service transcribed the clip and there were no words in it — and it is distinct from `failed` because the
 * payload says something different for each.
 */
export type Transcription =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "silent" }
	| { readonly kind: "failed"; readonly reason: string };

export interface TranscriberOptions {
	/**
	 * The endpoint: `multipart/form-data`, one `file` part, `{"text": "…"}` back. An optional `model` field is the
	 * service's business — this container sends no model and takes whatever the service was started with.
	 */
	readonly url: string;
	/** The route to it. The platform's own fetch, because this is not Telegram and the VPN proxy is Telegram's. */
	readonly fetch: Fetch;
	/** How long one request may take. Injected so a test does not wait the real twenty seconds. */
	readonly timeoutMs?: number;
	/** The largest file worth posting, in bytes. Injected for the same reason the inbox's ceiling is. */
	readonly maxBytes?: number;
}

export class Transcriber {
	readonly #url: string;
	readonly #fetch: Fetch;
	readonly #timeoutMs: number;
	readonly #maxBytes: number;
	/**
	 * The service as a log line may name it: host and port, never the whole URL, which is where a token would be. Public
	 * because the boot line says which service is configured.
	 */
	readonly host: string;

	constructor(options: TranscriberOptions) {
		this.#url = options.url;
		this.#fetch = options.fetch;
		this.#timeoutMs = options.timeoutMs ?? ASR_TIMEOUT_MS;
		this.#maxBytes = options.maxBytes ?? ASR_MAX_BYTES;
		this.host = hostOf(options.url);
	}

	/**
	 * The words in one saved file, or silence, or why there are none. The file is read here rather than handed in as
	 * bytes: the caller has a path (`src/inbox.ts` wrote it), and the size check has to happen before the read to be worth
	 * anything. What is read is posted unchanged — the file exactly as it landed, never a re-encoding of it.
	 */
	async transcribe(file: EventFile): Promise<Transcription> {
		if (file.size > this.#maxBytes) {
			return {
				kind: "failed",
				reason: `it is ${size(file.size)} and this container transcribes at most ${size(this.#maxBytes)}`,
			};
		}
		let bytes: Uint8Array;
		try {
			bytes = await readFile(file.path);
		} catch (error) {
			return { kind: "failed", reason: `the file could not be read back: ${describeError(error)}` };
		}
		const form = new FormData();
		// The name matters as much as the bytes: a service that sniffs an extension has nothing else to go on, and the inbox
		// name already carries the kind's own (`.ogg` for a voice note, `.mp4` for a round video).
		form.append("file", new Blob([bytes], { type: mimeFor(file) }), file.name);
		// One controller for the request and the body: a service that answers a status and then stalls is a service this
		// message does not wait for either.
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
		try {
			const answer = await this.#fetch(this.#url, {
				method: "POST",
				headers: {},
				body: form,
				signal: controller.signal,
			});
			if (!answer.ok) {
				// The body is not a transcript and is never quoted. It is read and dropped so the client is not left holding a
				// connection open for an answer nobody wants; a body that dies mid-read still leaves the status to report.
				await answer.text().catch(() => "");
				return { kind: "failed", reason: `${this.host} answered ${answer.status}` };
			}
			const reading = transcriptIn(await answer.text());
			if (reading.kind === "malformed") {
				return { kind: "failed", reason: `${this.host} answered ${answer.status} with no transcript in the body` };
			}
			return reading;
		} catch (error) {
			if (controller.signal.aborted) {
				return { kind: "failed", reason: `${this.host} did not answer within ${formatDuration(this.#timeoutMs)}` };
			}
			return { kind: "failed", reason: `${this.host} could not be reached: ${describeError(error)}` };
		} finally {
			clearTimeout(timer);
		}
	}
}

/** What a `200`'s body came to: a transcript, a legitimate silence, or an answer that is neither. */
type Answer =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "silent" }
	| { readonly kind: "malformed" };

/**
 * The transcript in an answer.
 *
 * The contract is `{"text": "…"}`; a plain-text body is read too, because that is the other shape this setting accepted
 * from the start. A body that begins with `{` or `[` is trying to be JSON, so it has to parse into an object with a
 * string `text` — a service that answers JSON and delivers half of it, or an array, has not delivered a transcript —
 * while anything else is the text itself.
 *
 * An empty text is a success and not a malformed answer: a clip of silence, a cough, a voice note recorded by accident is
 * a message somebody sent, and the service heard what was in it. The text is trimmed and cut at `ASR_TEXT_MAX` either
 * way: the payload has a 2 000-character cap of its own, and a service answering with a document must not make this
 * container carry one.
 */
function transcriptIn(body: string): Answer {
	const trimmed = body.trim();
	if (trimmed === "") return { kind: "silent" };
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return { kind: "malformed" };
		}
		if (typeof parsed !== "object" || parsed === null) return { kind: "malformed" };
		const text = (parsed as { readonly text?: unknown }).text;
		if (typeof text !== "string") return { kind: "malformed" };
		return spoken(trimmedText(text));
	}
	return spoken(trimmedText(trimmed));
}

/** One transcript as the answer it is: words when there are words, silence when there are none. */
function spoken(text: string): Answer {
	return text === "" ? { kind: "silent" } : { kind: "text", text };
}

/** The transcript as it goes into the payload: no surrounding whitespace, one line ending, and no more than is carried. */
function trimmedText(text: string): string {
	return text.trim().replace(/\r\n?/g, "\n").slice(0, ASR_TEXT_MAX);
}

/**
 * The content type of the part, from the name the inbox wrote the file under. A name with no extension — an `audio`
 * whose only title was, say, a song's — is sent as bytes rather than as a type this container guessed.
 */
function mimeFor(file: EventFile): string {
	switch (file.name.toLowerCase().split(".").at(-1) ?? "") {
		case "ogg":
		case "oga":
		case "opus":
			return "audio/ogg";
		case "mp3":
		case "mpeg":
			return "audio/mpeg";
		case "m4a":
			return "audio/mp4";
		case "wav":
			return "audio/wav";
		case "flac":
			return "audio/flac";
		case "mp4":
			return "video/mp4";
		default:
			return "application/octet-stream";
	}
}

/** A byte count as one clause: bytes, kibibytes, or tenths of a mebibyte — whichever reads as the number it is. */
function size(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
	return `${Math.ceil((bytes / (1024 * 1024)) * 10) / 10} MiB`;
}

/** The host of the endpoint, for the lines that may name the service. The URL itself is never logged. */
function hostOf(url: string): string {
	try {
		const { host } = new URL(url);
		// `readConfig` checks the scheme, not that there is a host: `http:///transcribe` is a URL and not a place, and a
		// line reading " answered 500" would be worse than one that says which service it was.
		return host === "" ? "the transcription service" : host;
	} catch {
		// Unreachable through `readConfig`, which refuses a non-URL at boot; a class that throws in its constructor because
		// of a string it did not need to parse would be the worse trade.
		return "the transcription service";
	}
}
