/**
 * The envelope, as the door will read it.
 *
 * These are the strings the model is shown, so they are pinned exactly rather than by shape: a rendering that drifted
 * would change what the agent thinks a chat message says, and nobody would notice until it answered the wrong thing.
 * The signature test checks the one thing a sender can get wrong that the door cannot forgive — signing bytes it did not
 * send — by rebuilding the header with mason's own idiom from `src/server/events.ts` and comparing bytes.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { envelopeFor, PAYLOAD_MAX, renderPayload, signBody, type ChatEvent } from "../src/envelope.ts";

function event(overrides: Partial<ChatEvent> = {}): ChatEvent {
	return {
		updateId: 8_811,
		sender: "Ilya",
		username: "ilya",
		chatId: "-1001234",
		chatTitle: "Team chat",
		replyToMessageId: undefined,
		text: "ship it?",
		...overrides,
	};
}

describe("the event payload", () => {
	it("renders a plain message with the sender, the handle, the chat and the id", () => {
		assert.equal(renderPayload(event()), "Ilya (@ilya) in chat -1001234 (Team chat): ship it?");
	});

	it("names the message it answers when it is a reply", () => {
		assert.equal(
			renderPayload(event({ replyToMessageId: 8_811 })),
			"Ilya (@ilya) in chat -1001234 (Team chat), replying to 8811: ship it?",
		);
	});

	it("leaves the handle out when the sender has no username, and keeps everything else", () => {
		assert.equal(renderPayload(event({ username: undefined })), "Ilya in chat -1001234 (Team chat): ship it?");
	});

	it("leaves the title out of a chat that has none, which is what a private chat looks like", () => {
		assert.equal(renderPayload(event({ chatId: "4711", chatTitle: undefined })), "Ilya (@ilya) in chat 4711: ship it?");
	});

	it("carries the chat id in the payload, because the reply needs it and a payload is a string", () => {
		assert.match(renderPayload(event({ chatId: "-1009876543210" })), /in chat -1009876543210 \(/);
	});

	it("cuts a message the door would refuse, and says so where it cut", () => {
		const payload = renderPayload(event({ text: "x".repeat(PAYLOAD_MAX * 2) }));
		assert.equal(payload.length, PAYLOAD_MAX);
		assert.ok(payload.endsWith("… [truncated]"), payload.slice(-25));
	});

	it("keys the event by the update id, so a redelivery is the same fire", () => {
		assert.deepEqual(envelopeFor(event()), {
			v: 1,
			id: "tg-8811",
			kind: "chat.message",
			payload: "Ilya (@ilya) in chat -1001234 (Team chat): ship it?",
		});
	});
});

describe("the event signature", () => {
	/** The door's own idiom, copied from src/server/events.ts rather than imported: this package ships alone. */
	function doorSignature(secret: string, body: string): string {
		return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
	}

	it("is the byte-identical HMAC over the body that is posted", () => {
		const secret = "0f".repeat(32);
		const body = JSON.stringify(envelopeFor(event()));
		assert.equal(signBody(secret, body), doorSignature(secret, body));
		assert.match(signBody(secret, body), /^sha256=[0-9a-f]{64}$/);
	});

	it("is over the bytes, not over a re-serialisation of them", () => {
		const secret = "1e".repeat(32);
		const spaced = '{"v":1, "id":"tg-1", "kind":"chat.message", "payload":"hi"}';
		const tight = JSON.stringify(JSON.parse(spaced) as unknown);
		assert.notEqual(signBody(secret, spaced), signBody(secret, tight));
		assert.equal(signBody(secret, spaced), doorSignature(secret, spaced));
	});
});
