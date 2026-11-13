import assert from "node:assert/strict";
import { test } from "node:test";
import { isChordError } from "@earendil-works/chord";
import { compile } from "@earendil-works/pi-schema";
import {
	AppendSchema,
	CONTRACT,
	CONTRACTS,
	CONVERSATION_TRANSITIONS,
	ControlResultSchema,
	ConversationStateSchema,
	chordCodeFor,
	connectorHost,
	ERROR_CODE,
	errorCodeOf,
	MasonPeer,
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

test("there is one contract, placed where the protocol says", () => {
	assert.deepEqual(
		CONTRACTS.map((contract) => contract.name),
		[CONTRACT.peer],
	);
	const def = CONTRACTS[0]?.def as { host?: unknown };
	assert.equal(CONTRACTS[0]?.name, "mason.peer");
	assert.deepEqual(def.host, { name: "mason" });
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
	assert.equal(compile(AppendSchema).check({ ...submission, type: "reply" }), false, "an append is one of two things");
	assert.equal(
		compile(AppendSchema).check({ type: "notice", appendId: "n-1", text: "the channel was muted" }),
		false,
		"a notice is not an append any more: a connector with something to say raises an event",
	);
	assert.equal(compile(ControlResultSchema).check({ handled: true, op: "stop" }), true);

	// The conversation is the read model, and the type a client reads it with is the schema the wire validates.
	const conversation = {
		revision: 3,
		transcript: [
			{ kind: "user" as const, id: "1", text: "Check the deploy." },
			{ kind: "delivered" as const, id: "reply:m1", text: "Half a sen", streaming: true },
			{ kind: "event" as const, id: "4", name: "chat.message" },
			{ kind: "notice" as const, id: "failed:5", text: "Something went wrong, and the turn did not finish." },
		],
		queue: [{ id: 7, mode: "followUp", text: "Then check the logs.", withdrawable: true }],
		run: "generating" as const,
		busy: true,
		activeRunTaskId: "task-1",
		transitions: [{ kind: "run.started" as const, revision: 3, runTaskId: "task-1" }],
	} satisfies PeerRef["conversation"]["value"];
	assert.equal(compile(ConversationStateSchema).check(conversation), true);
	assert.equal(compile(ConversationStateSchema).check({ ...conversation, revision: "3" }), false);
	assert.equal(
		compile(ConversationStateSchema).check({ ...conversation, transitions: [{ kind: "run.paused", revision: 3 }] }),
		false,
		"a transition is one of the six the protocol names",
	);
});

/**
 * What the conversation member declares, read from the description a link actually carries.
 *
 * The Appiary client reads exactly these fields and no others; a field added here without the client reading it is a
 * field the wire pays for and nobody uses, and a field the client reads that is not here is a frame it cannot get.
 */
test("the conversation member carries the read model and nothing else", () => {
	type JsonSchema = {
		readonly properties?: Record<string, any>;
		readonly required?: readonly string[];
		readonly anyOf?: readonly JsonSchema[];
		readonly items?: JsonSchema;
		readonly const?: unknown;
		readonly enum?: readonly unknown[];
	};
	const member = MasonPeer.description.variants.default?.conversation as unknown as {
		kind: string;
		schema: JsonSchema;
	};
	assert.equal(member.kind, "state");
	assert.deepEqual(Object.keys(member.schema.properties ?? {}).sort(), [
		"activeRunTaskId",
		"busy",
		"queue",
		"revision",
		"run",
		"transcript",
		"transitions",
	]);
	const rows: readonly JsonSchema[] = member.schema.properties?.transcript.items?.anyOf ?? [];
	assert.deepEqual(
		rows.map((row) => row.properties?.kind.const),
		["user", "delivered", "event", "notice"],
	);
	// A streamed message has to be the row it settles into: same id, plus the two marks a client renders.
	const delivered = rows[1];
	assert.deepEqual(delivered?.required, ["kind", "id", "text"]);
	assert.deepEqual(Object.keys(delivered?.properties ?? {}), ["kind", "id", "text", "failed", "streaming"]);
	assert.deepEqual(member.schema.properties?.transitions.items?.properties?.kind.enum, [...CONVERSATION_TRANSITIONS]);
});
