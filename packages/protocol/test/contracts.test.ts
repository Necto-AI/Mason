import assert from "node:assert/strict";
import { test } from "node:test";
import { isChordError } from "@earendil-works/chord";
import { compile } from "@earendil-works/pi-schema";
import {
	AckSchema,
	AppendSchema,
	CONTRACT,
	CONTRACTS,
	ControlResultSchema,
	chordCodeFor,
	connectorHost,
	DeliverSchema,
	ERROR_CODE,
	errorCodeOf,
	masonError,
	type PeerRef,
	PROTOCOL_MAJOR,
	SessionSchema,
} from "../src/index.ts";

test("one connector lives at one host name, and its name is the credential's", () => {
	assert.equal(connectorHost("telegram"), "connector:telegram");
});

test("a refusal keeps its code across the wire, because Chord keeps only the reason", () => {
	const error = masonError(ERROR_CODE.kindNotPermitted, "that kind fires no routine");
	assert.ok(isChordError(error, "forbidden"));
	assert.equal(error.reason, ERROR_CODE.kindNotPermitted);
	assert.equal(errorCodeOf(error), ERROR_CODE.kindNotPermitted);
	assert.equal(errorCodeOf(new Error("something else")), undefined);
	assert.equal(chordCodeFor(ERROR_CODE.rateLimited), "unavailable");
	assert.equal(chordCodeFor(ERROR_CODE.invalidRequest), "invalid");
	assert.equal(chordCodeFor(ERROR_CODE.actorUnknown), "forbidden");
});

test("the two contracts are the two names, placed where the protocol says", () => {
	assert.deepEqual(
		CONTRACTS.map((contract) => contract.name),
		[CONTRACT.peer, CONTRACT.connector],
	);
	const placements = CONTRACTS.map((contract) => {
		const def = contract.def as { host?: unknown };
		return def.host;
	});
	assert.equal(CONTRACTS[0]?.name, "mason.peer");
	assert.deepEqual(placements[0], { name: "mason" });
	assert.deepEqual(placements[1], { prefix: "connector:", key: "connector" });
	assert.equal(PROTOCOL_MAJOR, 1);
});

test("the shape the type says and the shape the schema validates are one shape", () => {
	// A session the schema accepts is a session the connector's interface describes: the state is the handshake.
	const session = {
		protocol: 1,
		commands: ["stop"],
		kinds: ["chat.message"],
		limits: {
			submissionsPerMinute: 60,
			firesPerMinute: 6,
			controlsPerMinute: 6,
			attachmentsPerMinute: 30,
			attachmentBytes: 1,
			attachmentTtlMs: 1,
		},
	} satisfies PeerRef["session"]["value"];
	assert.equal(compile(SessionSchema).check(session), true);
	assert.equal(compile(SessionSchema).check({ ...session, protocol: "one" }), false);

	const submission = {
		type: "submission" as const,
		appendId: "a-1",
		content: [{ type: "text" as const, text: "hello" }],
		origin: { ref: "chat-1" },
	};
	assert.equal(compile(AppendSchema).check(submission), true);
	assert.equal(
		compile(AppendSchema).check({ ...submission, type: "reply" }),
		false,
		"an append is one of three things",
	);

	const delivery = { deliveryId: "d-1", blocks: [{ type: "text", text: "hi" }], ref: "chat-1" };
	assert.equal(compile(DeliverSchema).check(delivery), true);
	assert.equal(compile(AckSchema).check({ status: "delivered" }), true);
	assert.equal(compile(AckSchema).check({ status: "sent" }), false);
	assert.equal(compile(ControlResultSchema).check({ handled: true, op: "stop" }), true);
});
