/**
 * One delivery, as the door sees it: the bytes, the header, and what each answer means.
 *
 * The statuses here are the three cases the trigger face has to survive without a person: accepted, refused (which is
 * final and must not be retried) and unreachable (which is retried and then abandoned). The request the fake receives is
 * asserted byte for byte, because the signature is over those bytes and over nothing else.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventDoor } from "../src/door.ts";
import type { EventEnvelope } from "../src/envelope.ts";
import { createLog, type Log } from "../src/log.ts";
import { signBody } from "../src/envelope.ts";
import type { Fetch, FetchRequest, FetchResponse } from "../src/telegram.ts";

const SECRET = "0f".repeat(32);
const ENVELOPE: EventEnvelope = {
	v: 1,
	id: "tg-8811",
	kind: "chat.message",
	payload: "Ilya (@ilya) in chat -1001234 (Team chat): ship it?",
};

interface Sent {
	readonly url: string;
	readonly request: FetchRequest;
}

function answer(status: number, body: string): FetchResponse {
	return { ok: status >= 200 && status < 300, status, statusText: "", text: async () => body };
}

interface Door {
	readonly door: EventDoor;
	readonly sent: Sent[];
	readonly lines: string[];
	readonly waits: number[];
}

function door(respond: (attempt: number) => FetchResponse): Door {
	const sent: Sent[] = [];
	const lines: string[] = [];
	const waits: number[] = [];
	const log: Log = createLog([], (line) => lines.push(line));
	const fetch: Fetch = async (url, request) => {
		sent.push({ url, request });
		return respond(sent.length);
	};
	return {
		sent,
		lines,
		waits,
		door: new EventDoor({
			url: "http://mason:8787/api/events/telegram",
			secret: SECRET,
			fetch,
			log,
			integration: "telegram",
			sleep: async (ms) => {
				waits.push(ms);
			},
		}),
	};
}

describe("a delivery the door accepts", () => {
	it("posts the envelope as JSON to the configured URL, with the signature over those exact bytes", async () => {
		const rig = door(() => answer(202, ""));

		const result = await rig.door.fire(ENVELOPE);

		assert.deepEqual(result, { kind: "accepted" });
		assert.equal(rig.sent.length, 1);
		assert.equal(rig.sent[0]?.url, "http://mason:8787/api/events/telegram");
		assert.equal(rig.sent[0]?.request.method, "POST");
		const body = rig.sent[0]?.request.body ?? "";
		assert.deepEqual(JSON.parse(body), ENVELOPE);
		assert.equal(rig.sent[0]?.request.headers["x-mason-signature"], signBody(SECRET, body));
		assert.match(rig.lines.join("\n"), /delivered tg-8811 \(chat\.message\)/);
	});
});

describe("a delivery the door refuses", () => {
	it("logs the status with the body's own error, and does not try again", async () => {
		const rig = door(() => answer(401, JSON.stringify({ error: "bad or missing signature" })));

		const result = await rig.door.fire(ENVELOPE);

		assert.deepEqual(result, { kind: "refused", status: 401 });
		assert.equal(rig.sent.length, 1);
		const logged = rig.lines.join("\n");
		assert.match(logged, /telegram: the door refused tg-8811 with 401: bad or missing signature/);
		assert.match(logged, /the offset advances past it/);
	});

	it("treats a 400 naming a field and a 404 naming an integration the same way: final", async () => {
		for (const status of [400, 404]) {
			const rig = door(() => answer(status, JSON.stringify({ error: "no enabled trigger face there" })));
			assert.deepEqual(await rig.door.fire(ENVELOPE), { kind: "refused", status });
			assert.equal(rig.sent.length, 1);
		}
	});

	it("gives up on a body that is not JSON rather than pretending it read one", async () => {
		const rig = door(() => answer(502, "<html>proxy says no</html>"));

		assert.deepEqual(await rig.door.fire(ENVELOPE), { kind: "refused", status: 502 });
		assert.match(rig.lines.join("\n"), /502: <html>proxy says no<\/html>/);
	});
});

describe("a delivery the network would not carry", () => {
	it("is retried three times with backoff, then abandoned, and the offset moves on", async () => {
		const rig = door(() => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
		});

		const result = await rig.door.fire(ENVELOPE);

		assert.equal(rig.sent.length, 4);
		assert.deepEqual(rig.waits, [250, 500, 1_000]);
		assert.deepEqual(result, { kind: "unreachable", error: "connect ECONNREFUSED 127.0.0.1:8787" });
		assert.match(rig.lines.join("\n"), /could not deliver tg-8811 after 4 attempts/);
	});

	it("stops retrying as soon as one attempt is accepted", async () => {
		const rig = door((attempt) => {
			if (attempt < 3) throw new Error("connect ECONNREFUSED");
			return answer(202, "");
		});

		assert.deepEqual(await rig.door.fire(ENVELOPE), { kind: "accepted" });
		assert.equal(rig.sent.length, 3);
		assert.deepEqual(rig.waits, [250, 500]);
	});
});
