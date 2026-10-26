/**
 * One delivery, as the door sees it: the bytes, the header, and what each answer means.
 *
 * The statuses here are the cases the trigger face has to survive without a person: accepted, refused (only the five a
 * retry would get the same answer to, which is final), over budget (which is a wait, and the same bytes go again) and
 * unreachable (a network failure, or an answer that is no verdict at all, reported so the batch is held rather than
 * advanced past). The request the fake receives is asserted byte for byte, because the signature is over those bytes and
 * over nothing else.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventDoor, type DoorResult } from "../src/door.ts";
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
const COMMAND: EventEnvelope = { v: 1, id: "tg-8812", kind: "command", payload: "stop" };

/** An accepted answer that says nothing about a command: a message's `202`, which is what every event is. */
const ACCEPTED: DoorResult = { kind: "accepted", answer: { handled: false, reply: undefined } };

interface Sent {
	readonly url: string;
	readonly request: FetchRequest;
}

function answer(status: number, body: string, headers: Record<string, string> = {}): FetchResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: "",
		headers: { get: (name) => headers[name.toLowerCase()] ?? null },
		text: async () => body,
		// Every answer the door reads is JSON; the member is here because the type is shared with a file download.
		arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
	};
}

/** mason's `429`, as `src/server/main.ts` writes it: the header and the body's own field, saying the same number. */
function tooManyDeliveries(seconds: number): FetchResponse {
	return answer(429, JSON.stringify({ error: "too many deliveries", retryAfterSeconds: seconds }), {
		"retry-after": String(seconds),
	});
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

		assert.deepEqual(result, ACCEPTED);
		assert.equal(rig.sent.length, 1);
		assert.equal(rig.sent[0]?.url, "http://mason:8787/api/events/telegram");
		assert.equal(rig.sent[0]?.request.method, "POST");
		const body = rig.sent[0]?.request.body ?? "";
		assert.deepEqual(JSON.parse(body), ENVELOPE);
		assert.equal(rig.sent[0]?.request.headers["x-mason-signature"], signBody(SECRET, body));
		assert.match(rig.lines.join("\n"), /delivered tg-8811 \(chat\.message\)/);
	});

	it("reads the answer a command gets, so the relay knows whether it was handled and what to post", async () => {
		const handled = door(() => answer(200, JSON.stringify({ handled: true, reply: "stopped" })));
		assert.deepEqual(await handled.door.fire(COMMAND), {
			kind: "accepted",
			answer: { handled: true, reply: "stopped" },
		});
		assert.match(handled.lines.join("\n"), /delivered tg-8812 \(command\)/);

		// mason did not act: no reply, and the relay has a message to send down the ordinary path.
		const undeclared = door(() => answer(200, JSON.stringify({ handled: false })));
		assert.deepEqual(await undeclared.door.fire(COMMAND), {
			kind: "accepted",
			answer: { handled: false, reply: undefined },
		});

		// An empty reply is no reply: Telegram refuses an empty message, and a chat that read nothing is the one outcome
		// worse than an answer that came too late.
		const silent = door(() => answer(200, JSON.stringify({ handled: true, reply: "" })));
		assert.deepEqual(await silent.door.fire(COMMAND), {
			kind: "accepted",
			answer: { handled: true, reply: undefined },
		});
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

	it("treats every status the door refuses deterministically the same way: final", async () => {
		for (const status of [400, 404, 405, 413]) {
			const rig = door(() => answer(status, JSON.stringify({ error: "no enabled trigger face there" })));
			assert.deepEqual(await rig.door.fire(ENVELOPE), { kind: "refused", status });
			assert.equal(rig.sent.length, 1);
		}
	});

	it("does not treat a 5xx from the door as final, because a door that failed did not refuse", async () => {
		// mason's own 500 (`src/server/main.ts`, the hook fired into a boot that no longer defines it), a sidecar's 502,
		// and a status nobody wrote down: none of them is a verdict on the bytes, so the batch must be held.
		for (const status of [500, 502, 503, 418]) {
			const rig = door(() => answer(status, JSON.stringify({ error: "the integration's hook is not a hook" })));

			const result = await rig.door.fire(ENVELOPE);

			assert.deepEqual(result, {
				kind: "unreachable",
				error: `the door answered ${status}: the integration's hook is not a hook`,
			});
			// The network retries, unchanged: `250, 500, 1000` ms, then the report that holds the batch.
			assert.equal(rig.sent.length, 4);
			assert.deepEqual(rig.waits, [250, 500, 1_000]);
			assert.doesNotMatch(rig.lines.join("\n"), /the offset advances past it/);
		}
	});

	it("holds the batch for a body that is not JSON rather than pretending it read one", async () => {
		const rig = door(() => answer(502, "<html>proxy says no</html>"));

		assert.deepEqual(await rig.door.fire(ENVELOPE), {
			kind: "unreachable",
			error: "the door answered 502: <html>proxy says no</html>",
		});
		assert.match(rig.lines.join("\n"), /could not deliver tg-8811 after 4 attempts/);
		assert.match(rig.lines.join("\n"), /the batch will be retried/);
	});
});

describe("a delivery the door is over budget for", () => {
	it("waits the retry-after it named, and posts the same bytes again", async () => {
		const rig = door((attempt) => (attempt === 1 ? tooManyDeliveries(42) : answer(202, "")));

		const result = await rig.door.fire(ENVELOPE);

		assert.deepEqual(result, ACCEPTED);
		assert.equal(rig.sent.length, 2);
		assert.deepEqual(rig.waits, [42_000]);
		// One fire, whichever delivery reached the door: the id is the dedupe and the bytes are identical.
		assert.equal(rig.sent[1]?.request.body, rig.sent[0]?.request.body);
		assert.equal(rig.sent[1]?.request.headers["x-mason-signature"], rig.sent[0]?.request.headers["x-mason-signature"]);
		const logged = rig.lines.join("\n");
		assert.match(logged, /over its budget; waiting 42s and posting tg-8811 again/);
		// One line for the wait, and one for the delivery: not one per second of it.
		assert.equal(rig.lines.length, 2);
	});

	it("reads retryAfterSeconds from the body when the answer carries no header", async () => {
		const rig = door((attempt) =>
			attempt === 1
				? answer(429, JSON.stringify({ error: "too many deliveries", retryAfterSeconds: 3 }))
				: answer(202, ""),
		);

		assert.deepEqual(await rig.door.fire(ENVELOPE), ACCEPTED);
		assert.deepEqual(rig.waits, [3_000]);
	});

	it("does not eat the network retries: a 429 wait is not a failed attempt", async () => {
		const rig = door((attempt) => {
			if (attempt === 1) throw new Error("connect ECONNREFUSED");
			return attempt === 2 ? tooManyDeliveries(1) : answer(202, "");
		});

		assert.deepEqual(await rig.door.fire(ENVELOPE), ACCEPTED);
		assert.deepEqual(rig.waits, [250, 1_000]);
	});

	it("reports a wait longer than it will sit through as unreachable, so the batch is held", async () => {
		const rig = door(() => tooManyDeliveries(3_600));

		const result = await rig.door.fire(ENVELOPE);

		assert.deepEqual(result, { kind: "unreachable", error: "the door answered 429 with a 3600s wait" });
		assert.equal(rig.sent.length, 1);
		assert.deepEqual(rig.waits, []);
		assert.match(rig.lines.join("\n"), /named a 3600s wait for tg-8811; holding it rather than advancing past it/);
	});

	it("states a fractional wait in the same whole seconds as every other line", async () => {
		const rig = door((attempt) => (attempt === 1 ? answer(429, "", { "retry-after": "3.5" }) : answer(202, "")));

		assert.deepEqual(await rig.door.fire(ENVELOPE), ACCEPTED);
		assert.deepEqual(rig.waits, [3_500]);
		assert.match(rig.lines.join("\n"), /over its budget; waiting 4s and posting tg-8811 again/);
	});

	it("reports a 429 that names no wait at all the same way, rather than guessing", async () => {
		const rig = door(() => answer(429, "<html>slow down</html>"));

		const result = await rig.door.fire(ENVELOPE);

		assert.deepEqual(result, { kind: "unreachable", error: "the door answered 429 with no wait it could read" });
		assert.deepEqual(rig.waits, []);
	});
});

describe("a delivery the network would not carry", () => {
	it("is retried three times with backoff, then reported so the batch is held", async () => {
		const rig = door(() => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
		});

		const result = await rig.door.fire(ENVELOPE);

		assert.equal(rig.sent.length, 4);
		assert.deepEqual(rig.waits, [250, 500, 1_000]);
		assert.deepEqual(result, { kind: "unreachable", error: "connect ECONNREFUSED 127.0.0.1:8787" });
		const logged = rig.lines.join("\n");
		assert.match(logged, /could not deliver tg-8811 after 4 attempts/);
		assert.match(logged, /the batch will be retried/);
		assert.doesNotMatch(logged, /the offset advances past it/);
	});

	it("stops retrying as soon as one attempt is accepted", async () => {
		const rig = door((attempt) => {
			if (attempt < 3) throw new Error("connect ECONNREFUSED");
			return answer(202, "");
		});

		assert.deepEqual(await rig.door.fire(ENVELOPE), ACCEPTED);
		assert.equal(rig.sent.length, 3);
		assert.deepEqual(rig.waits, [250, 500]);
	});
});
