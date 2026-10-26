/**
 * The transcription service: what this container posts, what it makes of each answer, and the two things it will not
 * spend a round trip on.
 *
 * The file is real — a path in the inbox is what a transcriber is handed — while the service is scripted, so each test is
 * one answer rather than a server, and "nothing was posted" is an assertion about an array rather than a socket that was
 * never opened.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isSpeech, Transcriber } from "../src/asr.ts";
import type { EventFile } from "../src/envelope.ts";
import type { Fetch, FetchRequest, FetchResponse, FileKind } from "../src/telegram.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

/** A throwaway volume for one test: the transcriber reads a file, so a file has to exist. */
async function tempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mason-asr-"));
	directories.add(root);
	return root;
}

/** Four bytes of Ogg header and a version byte: the tests are about sizes and answers, not about what the words are. */
const BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]);

const URL_UNDER_TEST = "http://asr.local:9000/transcribe";

/** A voice note on the volume, as `src/inbox.ts` reports one: the path is what the transcriber is given. */
async function voiceNote(overrides: Partial<EventFile> = {}): Promise<EventFile> {
	const path = join(await tempRoot(), "8811-voice-u1.ogg");
	await writeFile(path, BYTES);
	return { path, name: "8811-voice-u1.ogg", size: BYTES.byteLength, kind: "voice", ...overrides };
}

/** What the service answered, and every request made, so "no round trip" is a fact about this array. */
interface Service {
	readonly calls: { readonly url: string; readonly request: FetchRequest }[];
	readonly fetch: Fetch;
}

function scripted(answer: (request: FetchRequest) => Promise<FetchResponse>): Service {
	const calls: { url: string; request: FetchRequest }[] = [];
	return {
		calls,
		fetch: async (url, request) => {
			calls.push({ url, request });
			return answer(request);
		},
	};
}

function response(body: string, status = 200): FetchResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: "",
		text: async () => body,
		arrayBuffer: async () => new ArrayBuffer(0),
	};
}

/** A promise that only settles when the request is aborted, which is what a service that never answers looks like. */
function stalled(request: FetchRequest): Promise<FetchResponse> {
	return new Promise((_, reject) => {
		request.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
	});
}

function transcriber(service: Service, options: { timeoutMs?: number; maxBytes?: number } = {}): Transcriber {
	return new Transcriber({ url: URL_UNDER_TEST, fetch: service.fetch, ...options });
}

describe("posting a voice note", () => {
	it("sends one file part with the bytes from the inbox, and reads the text out of a JSON answer", async () => {
		// The answer is mason's Parakeet service's shape, extras and all: `text` is the transcript, and everything beside it
		// — words, timings, the model's name — is the service's business and is ignored here.
		const service = scripted(async () =>
			response(
				JSON.stringify({
					text: "  can you check the pricing sheet  ",
					words: [{ text: "can", startMs: 0, endMs: 160 }],
					durationMs: 1_200,
					elapsedMs: 180,
					rtf: 0.15,
					model: "parakeet-tdt-0.6b-v3",
				}),
			),
		);
		const note = await voiceNote();

		const outcome = await transcriber(service).transcribe(note);

		assert.deepEqual(outcome, { kind: "text", text: "can you check the pricing sheet" });
		assert.equal(service.calls.length, 1);
		const call = service.calls[0]!;
		assert.equal(call.url, URL_UNDER_TEST, "the configured endpoint, whole");
		assert.equal(call.request.method, "POST");
		assert.ok(call.request.signal instanceof AbortSignal, "the request can be cancelled when it hangs");
		const form = call.request.body;
		assert.ok(form instanceof FormData, "a form, not a JSON body");
		const parts = [...form.entries()];
		assert.equal(parts.length, 1, "one part is the whole contract: no model, no language, no chat id");
		const [name, value] = parts[0]!;
		assert.equal(name, "file");
		assert.ok(value instanceof File, "a named file part, because a service sniffs the extension");
		assert.equal(value.name, "8811-voice-u1.ogg");
		assert.equal(value.type, "audio/ogg");
		assert.deepEqual([...new Uint8Array(await value.arrayBuffer())], [...BYTES]);
	});

	it("reads a plain-text answer as the transcript, with its line endings made one", async () => {
		const service = scripted(async () => response("  ship it\r\non Thursday\n"));

		assert.deepEqual(await transcriber(service).transcribe(await voiceNote()), {
			kind: "text",
			text: "ship it\non Thursday",
		});
	});

	it("takes an empty transcript as silence, which is a success and not a failure", async () => {
		// A clip of silence, a cough, a note recorded by accident: the service transcribed what was there and there were no
		// words in it. The contract says `{"text": "…"}` and `""` is a value of it — and a plain empty body is the same
		// answer in the other shape this setting allows.
		const bodies = [
			JSON.stringify({ text: "" }),
			JSON.stringify({ text: "   " }),
			JSON.stringify({ text: "\n\t" }),
			"",
			"   \n",
		];
		for (const body of bodies) {
			const service = scripted(async () => response(body));
			const outcome = await transcriber(service).transcribe(await voiceNote());
			assert.deepEqual(outcome, { kind: "silent" }, `body: ${JSON.stringify(body)}`);
		}
	});

	it("takes an answer with no transcript in it as a failure, because half a document is not silence", async () => {
		// Silence is a transcribed clip with no words; these are answers that are not the promised shape at all, and the
		// difference matters: one says a person said nothing, the other says the words could not be had.
		for (const body of ['{"words":[{"text":"hi"}]}', '{"text":42}', '{"te', "[]"]) {
			const service = scripted(async () => response(body));
			const outcome = await transcriber(service).transcribe(await voiceNote());
			assert.deepEqual(
				outcome,
				{ kind: "failed", reason: "asr.local:9000 answered 200 with no transcript in the body" },
				`body: ${JSON.stringify(body)}`,
			);
		}
	});

	it("names a non-200 for what it is, without quoting the page it carries", async () => {
		let drained = false;
		const service = scripted(async () => ({
			...response("", 500),
			text: async () => {
				drained = true;
				return "<html>the model is loading</html>";
			},
		}));

		assert.deepEqual(await transcriber(service).transcribe(await voiceNote()), {
			kind: "failed",
			reason: "asr.local:9000 answered 500",
		});
		assert.ok(drained, "the body is drained rather than left holding the connection open");
	});

	it("gives up on a service that does not answer, and says after how long", async () => {
		const service = scripted(stalled);

		const outcome = await transcriber(service, { timeoutMs: 25 }).transcribe(await voiceNote());

		if (outcome.kind !== "failed") assert.fail(`expected a failure, got ${outcome.kind}`);
		assert.match(outcome.reason, /^asr\.local:9000 did not answer within \d+s$/, outcome.reason);
		assert.equal(service.calls.length, 1, "one request, abandoned rather than retried");
	});

	it("does not read or post a file over the size this container sends", async () => {
		// The path is not on the volume on purpose: a read would fail here, and the reason names the size instead.
		const missing = join(await tempRoot(), "8811-voice-u1.ogg");
		const note: EventFile = { path: missing, name: "8811-voice-u1.ogg", size: 4_096, kind: "voice" };
		const service = scripted(async () => response("never asked"));

		const outcome = await transcriber(service, { maxBytes: 1_024 }).transcribe(note);

		assert.deepEqual(outcome, {
			kind: "failed",
			reason: "it is 4 KiB and this container transcribes at most 1 KiB",
		});
		assert.equal(service.calls.length, 0, "an oversized note costs no round trip and no read");
	});

	it("answers a file that is no longer where the inbox put it, rather than throwing", async () => {
		const note = await voiceNote();
		await rm(note.path);
		const service = scripted(async () => response("never asked"));

		const outcome = await transcriber(service).transcribe(note);

		if (outcome.kind !== "failed") assert.fail(`expected a failure, got ${outcome.kind}`);
		assert.match(outcome.reason, /^the file could not be read back: /, outcome.reason);
		assert.equal(service.calls.length, 0);
	});
});

describe("what is worth transcribing", () => {
	const SPOKEN: readonly FileKind[] = ["voice", "audio", "video_note"];
	const SILENT: readonly FileKind[] = ["document", "photo", "video", "animation"];

	it("is the three kinds a person spoke into, and nothing else", () => {
		assert.deepEqual(SPOKEN.map((kind) => isSpeech(kind)), [true, true, true]);
		assert.deepEqual(SILENT.map((kind) => isSpeech(kind)), [false, false, false, false]);
	});
});
