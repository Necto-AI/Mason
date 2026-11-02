/**
 * The approval half of the connector contract: a question travels to the surface that started the turn, and the answer
 * that settles it comes back over the same socket.
 *
 * The question is a transcript entry (`app.permission`) the door sends as `connector/interaction.request`; the answer is
 * `mason/interaction.answer`, and the durable record of it is a second entry. That is why these tests read both: the
 * socket for what the person saw and answered, the log for what mason kept. The turn under test is a reply addressed
 * somewhere other than where it came from — the one cross-target send the gateway asks about without any MCP server.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ERROR_CODE, type InteractionRequestParams } from "@mason/protocol";
import { PERMISSION_ANSWER_ENTRY_KIND, PERMISSION_ENTRY_KIND } from "../src/server/permissions.ts";
import { REPLY_TOOL } from "../src/shared/contract.ts";
import { connectConnector, connectorHome, entriesOf, rawConnect, serveConnector, until } from "./support/connector.ts";

/** A turn whose reply is addressed to another conversation: the gateway asks before it is sent. */
function elsewhereTurns(message: string): readonly ReturnType<typeof fauxAssistantMessage>[] {
	return [
		fauxAssistantMessage(
			[fauxToolCall(REPLY_TOOL, { message, to: { connector: "telegram", conversation: "8811" } }, { id: "send" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(fauxText("sent")),
	];
}

/** Start a turn through the connector, as the person whose words it is. */
async function say(connected: Awaited<ReturnType<typeof connectConnector>>, text: string): Promise<void> {
	const outcome = await connected.connector.submit({
		origin: { connector: "telegram", externalConversationId: "-1001234" },
		actor: { externalActorId: "8811" },
		content: [{ type: "text", text }],
	});
	assert.equal(outcome.status, "accepted");
}

describe("a question the gateway asks", () => {
	it("reaches the surface that started the turn, and the person's answer settles it", async () => {
		const asked: InteractionRequestParams[] = [];
		const served = await serveConnector({ steps: elsewhereTurns("the numbers are in") });
		try {
			const connected = await connectConnector(served, {
				handlers: {
					onInteraction: (params) => {
						asked.push(params);
						return { delivered: true, surface: "the chat" };
					},
				},
			});
			try {
				await say(connected, "send it to my phone");
				await until(async () => asked.length === 1, "the question");
				const question = asked[0]!;
				assert.equal(question.tool.name, "reply");
				assert.equal(question.tool.connector, "telegram");
				assert.deepEqual(question.answers, ["allow", "deny"]);
				assert.match(question.reason, /instead of where the turn came from/);
				assert.equal(
					question.origin.externalConversationId,
					"-1001234",
					"the question goes where the words came from",
				);
				const block = question.blocks?.[0];
				assert.ok(
					block !== undefined && block.type === "text" && /Approve/.test(block.text),
					"the sentence to read",
				);

				// Nothing was sent while the question was open: the reply is committed only once the answer allows it.
				assert.equal(connected.deliveries.length, 0, "nothing was sent while the question was open");
				const settled = await connected.connector.answer({
					permissionId: question.permissionId,
					answer: "allow",
					by: { externalActorId: "8811" },
				});
				assert.deepEqual(settled, { settled: true });
				await until(async () => connected.deliveries.length === 1, "the approved delivery");
				assert.equal(connected.deliveries[0]?.text, "the numbers are in");

				// Both halves are in the log: the question, and the answer with who gave it.
				const stored = await entriesOf(served.server);
				assert.equal(stored.filter((entry) => entry.kind === PERMISSION_ENTRY_KIND).length, 1);
				const answer = stored.find((entry) => entry.kind === PERMISSION_ANSWER_ENTRY_KIND);
				assert.deepEqual(answer?.data, {
					permissionId: question.permissionId,
					answer: "allow",
					by: "Denis",
					at: (answer?.data as { at: number }).at,
				});
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("refuses an answer from anyone but the approver, and says why without settling", async () => {
		const asked: InteractionRequestParams[] = [];
		// A connector whose actor maps to somebody else: the operator named Denis the approver, and this is not Denis.
		const home = await connectorHome();
		const served = await serveConnector({ home, steps: elsewhereTurns("hello") });
		try {
			const connected = await connectConnector(served, {
				handlers: {
					onInteraction: (params) => {
						asked.push(params);
						return { delivered: true };
					},
				},
			});
			try {
				await say(connected, "send it to my phone");
				await until(async () => asked.length === 1, "the question");
				const refusedAnswer = await connected.connector.answer({
					permissionId: asked[0]!.permissionId,
					answer: "allow",
					by: { externalActorId: "9999" },
				});
				assert.equal(refusedAnswer.settled, false);
				assert.match(refusedAnswer.reason ?? "", /not the approver/);
				assert.equal(connected.deliveries.length, 0, "an answer from nobody does not send anything");

				// The approver's own answer still settles it: a wrongly answered question is not a lost one.
				const settled = await connected.connector.answer({
					permissionId: asked[0]!.permissionId,
					answer: "deny",
					by: { externalActorId: "8811" },
				});
				assert.deepEqual(settled, { settled: true });
				const late = await connected.connector.answer({
					permissionId: asked[0]!.permissionId,
					answer: "allow",
					by: { externalActorId: "8811" },
				});
				assert.equal(late.settled, false, "the first answer is the answer");
				assert.match(late.reason ?? "", /already answered/);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("answers an id nobody is waiting on with the protocol's own refusal", async () => {
		const served = await serveConnector();
		try {
			const raw = await rawConnect(served);
			try {
				const answer = await raw.call("mason/interaction.answer", {
					permissionId: "perm_nothing",
					answer: "allow",
					by: { externalActorId: "8811" },
				});
				assert.equal(answer.error?.data?.code, ERROR_CODE.unknownPermission);
			} finally {
				raw.close();
			}
		} finally {
			await served.close();
		}
	});
});
