/**
 * The delivery half of the connector contract: a committed reply is owed to one connector, sent once, acknowledged
 * durably, resent after a reconnect, and never retried when it may have been delivered.
 *
 * The outbox is the transcript itself — an `app.reply` entry is the commit, an `app.delivery` entry is the
 * acknowledgement — so these tests read the durable log for what happened and use the socket for what was sent. The
 * restart test uses the real SQLite file for the same reason: a commit that does not survive a process is not one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createConnector, nodeWebSocketLink } from "mason-connector";
import { MemoryStore } from "mason-connector/store/memory";
import type { DeliveryAck, DeliveryFinalParams } from "mason-protocol";
import WebSocket from "ws";
import { CONNECTOR_ENTRY_KIND, DELIVERY_ENTRY_KIND, REPLY_ENTRY_KIND, REPLY_TOOL } from "../src/shared/contract.ts";
import {
	connectConnector,
	connectorHome,
	entriesOf,
	fullFaces,
	replyTurns,
	serveConnector,
	until,
} from "./support/connector.ts";

/** Every entry of one kind, as plain JSON. */
async function entries(served: Awaited<ReturnType<typeof serveConnector>>, kind: string) {
	return (await entriesOf(served.server)).filter((entry) => entry.kind === kind);
}

/** The delivery records, newest first or oldest — the log's order does not matter to these assertions. */
async function acks(served: Awaited<ReturnType<typeof serveConnector>>) {
	return (await entries(served, DELIVERY_ENTRY_KIND)).map((entry) => entry.data as Record<string, unknown>);
}

/** One submission through a connected connector, which is how a reply gets committed. */
async function say(connected: Awaited<ReturnType<typeof connectConnector>>, text: string): Promise<void> {
	const outcome = await connected.connector.submit({
		origin: { connector: "telegram", externalConversationId: "-1001234" },
		actor: { externalActorId: "8811" },
		content: [{ type: "text", text }],
	});
	assert.equal(outcome.status, "accepted");
}

describe("a committed reply", () => {
	it("is sent once, acknowledged durably, and its ack is what stops a second send", async () => {
		const served = await serveConnector({ steps: replyTurns(["only once"]) });
		try {
			const connected = await connectConnector(served);
			try {
				await say(connected, "hello");
				await until(async () => (await acks(served)).length === 1, "the acknowledgement");
				const ack = (await acks(served))[0] as { deliveryId: string; status: string };
				assert.equal(ack.status, "delivered");
				assert.equal(ack.deliveryId, connected.deliveries[0]?.deliveryId);
				// Nothing is left owed: the outbox reads the ack entry and stops.
				const before = connected.deliveries.length;
				await served.server.connectors.flush();
				assert.equal(connected.deliveries.length, before);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("reaches the other connector while a slow acknowledgement holds the outbox", async () => {
		// Two connectors, one slow ack. The outbox is one pass over every open socket, so a reply committed for the second
		// connector while the first is mid-ack must still be sent — a pass that keeps the first caller's name strands it.
		const home = await connectorHome({ second: true });
		const served = await serveConnector({ home, steps: replyTurns(["to telegram", "to slack"]) });
		try {
			const telegram: Array<{ deliveryId: string; text: string }> = [];
			const slack: Array<{ deliveryId: string; text: string }> = [];
			const first = await connectConnector(served, {
				deliveries: telegram,
				handlers: {
					onDelivery: async (params) => {
						await new Promise((resolve) => setTimeout(resolve, 700));
						telegram.push({ deliveryId: params.deliveryId, text: "to telegram" });
						return { status: "delivered" };
					},
				},
			});
			const second = await connectConnector(served, {
				name: "slack",
				credential: home.secondCredential,
				faces: {
					user: {
						actors: [{ externalActorId: "777", displayName: "Denis" }],
						conversations: [{ externalConversationId: "777", kind: "person" }],
						capabilities: ["text"],
					},
				},
				deliveries: slack,
			});
			try {
				assert.equal(
					(
						await first.connector.submit({
							origin: { connector: "telegram", externalConversationId: "8811" },
							actor: { externalActorId: "8811" },
							content: [{ type: "text", text: "first" }],
						})
					).status,
					"accepted",
				);
				assert.equal(
					(
						await second.connector.submit({
							origin: { connector: "slack", externalConversationId: "777" },
							actor: { externalActorId: "777" },
							content: [{ type: "text", text: "second" }],
						})
					).status,
					"accepted",
				);
				// Both replies are owed. The second arrives while the first connector's send is still unanswered.
				await until(() => slack.length === 1, "the second connector's reply");
				assert.equal(slack[0]?.text, "to slack");
				await until(() => telegram.length === 1, "the first connector's reply");
				assert.equal(telegram[0]?.text, "to telegram");
				await until(async () => (await acks(served)).length === 2, "both acknowledgements");
			} finally {
				await first.close();
				await second.close();
			}
		} finally {
			await served.close();
		}
	});

	it("is resent after a reconnect under the same id, and the connector's own ledger answers duplicate", async () => {
		const served = await serveConnector({ steps: replyTurns(["a message that may have left"]) });
		try {
			// The handler drops the socket before the acknowledgement can travel: the send happened, the ack did not. That is
			// exactly the lost acknowledgement the whole outbox exists for.
			const holder: { connector?: ReturnType<typeof createConnector> } = {};
			const deliveries: DeliveryFinalParams[] = [];
			const connected = await connectConnector(served, {
				handlers: {
					onDelivery: (params) => {
						deliveries.push(params);
						holder.connector?.drop("the ack is lost");
						return { status: "delivered" };
					},
				},
			});
			holder.connector = connected.connector;
			try {
				await say(connected, "hello");
				await until(() => deliveries.length === 1, "the first send");
				// The reconnect resends the same delivery id; the SDK's ledger answers `duplicate` and the handler is not run
				// again, so the vendor saw one send.
				await until(async () => (await acks(served)).length === 1, "the ack after the reconnect");
				assert.equal(deliveries.length, 1, "one vendor send for one logical delivery");
				assert.equal(
					deliveries[0]?.deliveryId,
					(await entries(served, REPLY_ENTRY_KIND))[0]?.data === undefined
						? undefined
						: ((await entries(served, REPLY_ENTRY_KIND))[0]?.data as { deliveryId?: string }).deliveryId,
				);
				const ack = (await acks(served))[0] as { status: string };
				assert.equal(ack.status, "duplicate");
				assert.ok(connected.connector.status().connections >= 2, "the connector reconnected");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("is never retried when the connector reports an uncertain outcome, and the uncertainty is recorded", async () => {
		const served = await serveConnector({ steps: replyTurns(["maybe"]) });
		try {
			const connected = await connectConnector(served, {
				handlers: {
					onDelivery: (params) => {
						sends.push(params.deliveryId);
						return { status: "uncertain", detail: "the vendor timed out after the send" };
					},
				},
			});
			const sends: string[] = [];
			try {
				await say(connected, "hello");
				await until(async () => (await acks(served)).length === 1, "the uncertain acknowledgement");
				assert.equal((await acks(served))[0]?.status, "uncertain");
				assert.match(String((await acks(served))[0]?.detail), /vendor timed out/);
				connected.connector.drop("reconnect");
				await until(() => connected.connector.status().connected, "the reconnect");
				await new Promise((resolve) => setTimeout(resolve, 300));
				assert.equal(sends.length, 1, "an uncertain send is reported, never repeated");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("shows the uncertainty to the reader, because a message that may not have arrived is their business", async () => {
		const served = await serveConnector({ steps: replyTurns(["maybe"]) });
		try {
			const connected = await connectConnector(served, {
				handlers: { onDelivery: () => ({ status: "uncertain", detail: "no idea" }) },
			});
			try {
				await say(connected, "hello");
				await until(async () => (await acks(served)).length === 1, "the ack");
				const { projectTranscript } = await import("../src/server/projection.ts");
				const view = await served.server.runtime.viewSnapshot(BACKGROUND_CONTEXT);
				assert.ok(
					projectTranscript(view).some((item) => item.kind === "notice" && /may not have reached/.test(item.text)),
					"the transcript says the message may not have arrived",
				);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("a streaming origin", () => {
	it("gets start, delta and final under one delivery id", async () => {
		const long = Array.from({ length: 12 }, (_, index) => `sentence number ${index} of the answer.`).join(" ");
		// Paced, so the reply is observably half-written: a provider that answers in one tick has no `start`/`delta` to send.
		const served = await serveConnector({ steps: replyTurns([long]), tokensPerSecond: 300 });
		try {
			const frames: Array<{ method: string; params: Record<string, unknown> }> = [];
			// A raw socket is not enough here: the SDK's handlers are where start and delta arrive, and the SDK is what the
			// connector author actually writes.
			const connector = createConnector({
				name: "telegram",
				version: "test",
				url: served.url,
				credential: served.credential,
				faces: fullFaces({
					user: {
						actors: [{ externalActorId: "8811" }],
						conversations: [{ externalConversationId: "-1001234", kind: "room" }],
						capabilities: ["text", "streaming"],
					},
				}),
				store: new MemoryStore(),
				link: nodeWebSocketLink(WebSocket as never),
				heartbeatMs: 0,
				handlers: {
					onDeliveryStart: (params) => {
						frames.push({ method: "start", params: params as unknown as Record<string, unknown> });
					},
					onDeliveryDelta: (params) => {
						frames.push({ method: "delta", params: params as unknown as Record<string, unknown> });
					},
					onDelivery: (params): DeliveryAck => {
						frames.push({ method: "final", params: params as unknown as Record<string, unknown> });
						return { status: "delivered" };
					},
				},
			});
			await connector.start();
			try {
				const outcome = await connector.submit({
					origin: { connector: "telegram", externalConversationId: "-1001234" },
					actor: { externalActorId: "8811" },
					content: [{ type: "text", text: "tell me something long" }],
				});
				assert.equal(outcome.status, "accepted");
				await until(async () => (await acks(served)).length === 1, "the final", 10_000);
				const ids = new Set(frames.map((frame) => String(frame.params.deliveryId)));
				assert.equal(ids.size, 1, `one delivery id for the whole stream: ${JSON.stringify([...ids])}`);
				// One start, at least one delta, one final — and never a second start or a final before the last frame.
				const methods = frames.map((frame) => frame.method);
				assert.equal(methods[0], "start");
				assert.equal(methods.at(-1), "final");
				assert.equal(methods.filter((method) => method === "start").length, 1);
				assert.ok(methods.includes("delta"), `the stream carried a delta: ${methods.join(",")}`);
				assert.equal(methods.filter((method) => method === "final").length, 1);
				// The stream is progress and the final is the message: start plus every delta is a prefix of what the final
				// carries, never a second copy of it. A connector renders the final and uses the frames only to feel live.
				const started = String((frames[0]?.params.blocks as Array<{ text: string }>)[0]?.text);
				const deltas = frames
					.filter((frame) => frame.method === "delta")
					.map((frame) => String((frame.params.blocks as Array<{ text: string }>)[0]?.text))
					.join("");
				const final = String((frames.at(-1)?.params.blocks as Array<{ text: string }>)[0]?.text);
				assert.ok(long.startsWith(started + deltas), "start and deltas compose to a prefix of the message");
				assert.equal(final, long);
			} finally {
				await connector.stop();
			}
		} finally {
			await served.close();
		}
	});

	it("is sent the final alone when it never claimed streaming", async () => {
		const served = await serveConnector({ steps: replyTurns(["the whole answer all at once"]) });
		try {
			let starts = 0;
			const connected = await connectConnector(served, {
				handlers: {
					onDeliveryStart: () => {
						starts += 1;
					},
				},
			});
			try {
				await say(connected, "hello");
				await until(async () => (await acks(served)).length === 1, "the ack");
				assert.equal(starts, 0);
				assert.equal(connected.deliveries[0]?.text, "the whole answer all at once");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("reaches one destination: a mirror displays the reply, and a display causes no second send", async () => {
		const served = await serveConnector({ steps: replyTurns(["seen by everyone"]) });
		try {
			const origin = await connectConnector(served, { state: ["projection"] });
			try {
				await say(origin, "hello");
				await until(async () => (await acks(served)).length === 1, "the delivery to the origin");
				// One reply, one destination: the number of sends equals the number of committed replies, whatever else
				// subscribes to the transcript. A projection mirror reads the reply in state; it is never a delivery.
				const replies = await entries(served, REPLY_ENTRY_KIND);
				assert.equal(origin.deliveries.length, replies.length);
				const { projectTranscript } = await import("../src/server/projection.ts");
				const view = await served.server.runtime.viewSnapshot(BACKGROUND_CONTEXT);
				assert.ok(
					projectTranscript(view).some((item) => item.kind === "delivered" && item.text === "seen by everyone"),
				);
			} finally {
				await origin.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("a restart", () => {
	it("keeps a submission's claim, so the resend is a duplicate and not a second act", async () => {
		const home = await connectorHome();
		const first = await serveConnector({ home, storage: "sqlite" });
		try {
			const connected = await connectConnector(first);
			const outcome = await connected.connector.submit({
				submissionId: "tg-restart-1",
				origin: { connector: "telegram", externalConversationId: "-1001234" },
				actor: { externalActorId: "8811" },
				content: [{ type: "text", text: "before the restart" }],
			});
			assert.equal(outcome.status, "accepted");
			await connected.close();
		} finally {
			await first.close();
		}
		const second = await serveConnector({ home, storage: "sqlite" });
		try {
			const connected = await connectConnector(second);
			try {
				const again = await connected.connector.submit({
					submissionId: "tg-restart-1",
					origin: { connector: "telegram", externalConversationId: "-1001234" },
					actor: { externalActorId: "8811" },
					content: [{ type: "text", text: "after the restart" }],
				});
				assert.equal(again.status, "duplicate");
				assert.equal((await entries(second, CONNECTOR_ENTRY_KIND)).length, 1);
			} finally {
				await connected.close();
			}
		} finally {
			await second.close();
		}
	});

	it("resends a reply that was committed and never acknowledged", async () => {
		const home = await connectorHome();
		const first = await serveConnector({
			home,
			storage: "sqlite",
			steps: replyTurns(["committed before the restart"]),
		});
		try {
			// No connector is online: the reply is committed and stays owed, which is the state a restart must not lose.
			const conversation = await first.server.runtime.conversation();
			await conversation.submit(
				{
					type: "input",
					content: "say something durable",
					entry: {
						kind: CONNECTOR_ENTRY_KIND,
						data: { origin: { connector: "telegram", externalConversationId: "-1001234" } },
					},
				},
				BACKGROUND_CONTEXT,
			);
			await until(async () => (await entries(first, REPLY_ENTRY_KIND)).length === 1, "the reply to be committed");
			assert.equal((await acks(first)).length, 0, "nobody was there to acknowledge it");
		} finally {
			await first.close();
		}
		const second = await serveConnector({ home, storage: "sqlite" });
		try {
			const connected = await connectConnector(second);
			try {
				await until(() => connected.deliveries.length === 1, "the reply owed from the last process");
				assert.equal(connected.deliveries[0]?.text, "committed before the restart");
				await until(async () => (await acks(second)).length === 1, "the acknowledgement");
				assert.equal((await acks(second))[0]?.status, "delivered");
				assert.equal((await entries(second, REPLY_ENTRY_KIND)).length, 1, "one reply, sent once");
			} finally {
				await connected.close();
			}
		} finally {
			await second.close();
		}
	});
});

describe("a reply nobody can reach", () => {
	it("is recorded and reported, and the console still displays it", async () => {
		const served = await serveConnector({
			steps: [
				fauxAssistantMessage([fauxToolCall(REPLY_TOOL, { message: "into the void" })], { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxText("done")),
			],
		});
		try {
			const connected = await connectConnector(served);
			try {
				// A fire with no origin: the hooked turn has no conversation behind it.
				await connected.connector.fire({ fireId: "nobody-1", kind: "chat.message", payload: "ring" });
				await until(async () => (await entries(served, REPLY_ENTRY_KIND)).length === 1, "the recorded reply");
				const reply = (await entries(served, REPLY_ENTRY_KIND))[0]?.data as Record<string, unknown>;
				assert.equal(reply.target, undefined, "no medium is named");
				assert.equal(connected.deliveries.length, 0);
				await until(async () => (await entries(served, CONNECTOR_ENTRY_KIND)).length === 0, "no conversation");
				const { projectTranscript } = await import("../src/server/projection.ts");
				const view = await served.server.runtime.viewSnapshot(BACKGROUND_CONTEXT);
				assert.ok(
					projectTranscript(view).some((item) => item.kind === "delivered" && item.text === "into the void"),
					"the console reads what was recorded",
				);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});
