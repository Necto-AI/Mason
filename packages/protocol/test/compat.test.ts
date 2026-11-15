/**
 * The additive contract, as a test: the connector already deployed against v1 still binds to the contract that now
 * carries `conversation`.
 *
 * The claim is mechanical rather than a promise. Binding is directional — chord's `coverage()` requires the provider to
 * cover the members the *consumer* names and ignores what it does not — so a client frozen before the member existed
 * names `session`, `append` and `control`, is served exactly those, and receives no `conversation` frames at all
 * (`connection.js` streams only the members the consumer's own description lists).
 *
 * The consumer below is a contract of its own, written out member for member, not the served contract under another
 * name: `bind()` returns early when two fingerprints match, so a test that handed the served contract back to itself
 * would pass without reading a single member. The fingerprint assertion is what keeps this on the covered path.
 *
 * What is frozen is the member list and the fingerprint, because that is what this change alters: a restatement that
 * drifts — a schema edited underneath it, a member renamed — fails here instead of quietly proving that *a* three-member
 * contract binds. The schemas those members are declared with are restated by reference.
 *
 * One member was retired rather than added, and it is pinned separately below: #201 removes the `notice` append shape, and
 * a union member is not a field — a deployed consumer that still names it is not covered by the served append any more,
 * which is `coverage`'s answer and, through it, `bind`'s refusal. "The retired notice append is refused" is the test that
 * says so; the price is recorded in `PROTOCOL.md`'s versioning section, and it is why the console, the only connector this
 * repository ships, is rebuilt in the same change.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bind, coverage, hostNamed, isChordError, method, type RemoteContract, remote } from "@earendil-works/chord";
import { arr, lit, obj, opt, str, union, unknown } from "@earendil-works/pi-schema";
import {
	AppendResultSchema,
	AppendSchema,
	BlockSchema,
	CONTRACT,
	ControlResultSchema,
	ControlSchema,
	MasonPeer,
	OriginSchema,
	PROTOCOL_MAJOR,
	SessionSchema,
} from "../src/index.ts";

/**
 * The append v1 shipped: the three members a deployed connector holds, written out here rather than imported, because
 * the served contract no longer carries `notice` (#201).
 */
const AppendBeforeNoticeCut = union([
	obj(
		{
			type: lit("submission"),
			appendId: str(),
			content: arr(BlockSchema),
			origin: opt(OriginSchema),
			mode: opt(union([lit("followUp"), lit("steer"), lit("reject")])),
			capabilities: opt(arr(str())),
		},
		{ open: true },
	),
	obj(
		{
			type: lit("event"),
			appendId: str(),
			kind: str(),
			payload: opt(unknown()),
			summary: opt(str()),
			origin: opt(OriginSchema),
		},
		{ open: true },
	),
	obj({ type: lit("notice"), appendId: str(), text: str(), origin: opt(OriginSchema) }, { open: true }),
]);

/** The contract a connector deployed before `conversation` existed holds, member for member. */
function peerBeforeConversation(): RemoteContract {
	return remote(CONTRACT.peer, {
		// The literal, not the constant: this is a consumer frozen at the major it was built against, so bumping
		// `PROTOCOL_MAJOR` must fail this suite instead of moving the frozen client with the served contract.
		version: 1,
		input: MasonPeer.input,
		host: hostNamed("mason"),
		variants: {
			default: {
				state: { session: SessionSchema },
				methods: {
					append: method(AppendSchema, AppendResultSchema),
					control: method(ControlSchema, ControlResultSchema),
				},
			},
		},
	});
}

test("a connector deployed before the conversation member existed still binds", () => {
	const deployed = peerBeforeConversation();
	// The fingerprint of the frozen consumer: pinned so a restatement that drifts fails here rather than quietly proving
	// that *a* three-member contract binds.
	assert.equal(deployed.fingerprint, "f28f64c8e76c0e39");
	assert.notEqual(
		deployed.fingerprint,
		MasonPeer.fingerprint,
		"the frozen contract must differ from the served one, or binding would skip the coverage check",
	);
	assert.equal(coverage(MasonPeer.description, deployed.description), undefined);
	// `bind` is what a link does when the consumer's reference arrives; a gap throws here rather than degrading later.
	assert.doesNotThrow(() => bind(MasonPeer, undefined, deployed));
});

test("a major bump would refuse the v1 client this contract still serves", () => {
	// Two halves, and either one fails on a bump. The served major is still 1, which is the number the frozen consumer
	// above names; and binding is sensitive to it, so a served contract at another major refuses that client rather than
	// degrading into a link that serves it half a contract.
	assert.equal(PROTOCOL_MAJOR, 1);
	const nextMajor = remote(CONTRACT.peer, {
		version: PROTOCOL_MAJOR + 1,
		input: MasonPeer.input,
		host: hostNamed("mason"),
		variants: {
			default: {
				state: { session: SessionSchema },
				methods: {
					append: method(AppendSchema, AppendResultSchema),
					control: method(ControlSchema, ControlResultSchema),
				},
			},
		},
	});
	assert.throws(
		() => bind(nextMajor, undefined, peerBeforeConversation()),
		(error: unknown) => isChordError(error, "contract_mismatch"),
		"a client frozen at major 1 does not bind to a served contract at another major",
	);
});

test("the retired notice append is refused to a deployed consumer, not silently accepted", () => {
	const deployed = remote(CONTRACT.peer, {
		// The literal, not the constant: this is a consumer frozen at the major it was built against, so bumping
		// `PROTOCOL_MAJOR` must fail this suite instead of moving the frozen client with the served contract.
		version: 1,
		input: MasonPeer.input,
		host: hostNamed("mason"),
		variants: {
			default: {
				state: { session: SessionSchema },
				methods: { append: method(AppendBeforeNoticeCut, AppendResultSchema) },
			},
		},
	});
	assert.equal(
		coverage(MasonPeer.description, deployed.description),
		"default.append arguments",
		"a union member is not a field: the served append no longer covers the one that shipped",
	);
	assert.throws(
		() => bind(MasonPeer, undefined, deployed),
		(error: unknown) => isChordError(error, "contract_mismatch"),
		"a consumer holding the retired member does not bind, which is the visible price of the cut",
	);
});

test("the member a deployed connector does not name is the only one it lacks", () => {
	assert.deepEqual(Object.keys(MasonPeer.description.variants.default ?? {}).sort(), [
		"append",
		"control",
		"conversation",
		"session",
	]);
	assert.deepEqual(Object.keys(peerBeforeConversation().description.variants.default ?? {}).sort(), [
		"append",
		"control",
		"session",
	]);
});

test("a member the provider does not offer is refused, not silently accepted", () => {
	// The other direction is what makes the test above worth having: a consumer naming something mason does not serve
	// fails to bind, so a member cannot quietly disappear — or be assumed — behind a green suite.
	const consumer = remote(CONTRACT.peer, {
		// The literal, not the constant: this is a consumer frozen at the major it was built against, so bumping
		// `PROTOCOL_MAJOR` must fail this suite instead of moving the frozen client with the served contract.
		version: 1,
		input: MasonPeer.input,
		host: hostNamed("mason"),
		variants: {
			default: {
				state: { session: SessionSchema, transcript_archive: SessionSchema },
				methods: { append: method(AppendSchema, AppendResultSchema) },
			},
		},
	});
	try {
		bind(MasonPeer, undefined, consumer);
		assert.fail("a consumer that names a member mason does not serve must not bind");
	} catch (error) {
		assert.ok(isChordError(error, "contract_mismatch"), `expected a contract mismatch, got ${String(error)}`);
		assert.match(String((error as Error).message), /transcript_archive/);
	}
});
