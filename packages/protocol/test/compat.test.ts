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
 * What is frozen is the member list and the fingerprint, because that is what this change alters: the fingerprint is the
 * one `packages/protocol/src/index.ts` had at `e59a4c3`, so a restatement that drifts — a schema edited underneath it, a
 * member renamed — fails here instead of quietly proving that *a* three-member contract binds. The schemas those members
 * are declared with are otherwise restated by reference: a change to one of them is a different claim, pinned by "the
 * shape the type says and the shape the schema validates are one shape" in `contracts.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bind, coverage, hostNamed, isChordError, method, type RemoteContract, remote } from "@earendil-works/chord";
import {
	AppendResultSchema,
	AppendSchema,
	CONTRACT,
	ControlResultSchema,
	ControlSchema,
	MasonPeer,
	PROTOCOL_MAJOR,
	SessionSchema,
} from "../src/index.ts";

/** The contract a connector deployed before `conversation` existed holds, member for member. */
function peerBeforeConversation(): RemoteContract {
	return remote(CONTRACT.peer, {
		version: PROTOCOL_MAJOR,
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
	// The one number this suite rests on: it is `MasonPeer.fingerprint` at `e59a4c3`, the contract v1 shipped.
	assert.equal(deployed.fingerprint, "ac4fd4ec7911fb23");
	assert.notEqual(
		deployed.fingerprint,
		MasonPeer.fingerprint,
		"the frozen contract must differ from the served one, or binding would skip the coverage check",
	);
	assert.equal(coverage(MasonPeer.description, deployed.description), undefined);
	// `bind` is what a link does when the consumer's reference arrives; a gap throws here rather than degrading later.
	assert.doesNotThrow(() => bind(MasonPeer, undefined, deployed));
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
		version: PROTOCOL_MAJOR,
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
