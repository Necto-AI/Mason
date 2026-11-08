/**
 * The delivery half of the connector contract: a committed send is owed to one connector, delivered once, acknowledged
 * durably, resent after a reconnect, and never retried when it may have been delivered.
 *
 * The outbox is the transcript itself — an `app.reply` entry is the commit, an `app.delivery` entry is the
 * acknowledgement — so these tests read the durable log for what happened and use the socket for what was sent.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DELIVERY_ENTRY_KIND, REPLY_ENTRY_KIND } from "../src/shared/contract.ts";
import { connectConnector, connectorHome, entriesOf, replyTurns, serveConnector, until } from "./support/connector.ts";

/** Every entry of one kind, as plain JSON. */
async function entries(served: Awaited<ReturnType<typeof serveConnector>>, kind: string) {
	return (await entriesOf(served.server)).filter((entry) => entry.kind === kind);
}

/** The delivery records: what mason wrote down about each acknowledgement, including the unsure ones. */
async function acks(served: Awaited<ReturnType<typeof serveConnector>>) {
	return (await entries(served, DELIVERY_ENTRY_KIND)).map((entry) => entry.data as Record<string, unknown>);
}

/** One append through a connected connector, which is how a send gets committed. */
async function say(
	connected: Awaited<ReturnType<typeof connectConnector>>,
	text: string,
	address = "team",
): Promise<void> {
	const outcome = await connected.connector.submit({
		origin: { ref: address },
		content: [{ type: "text", text }],
	});
	assert.equal(outcome.status, "accepted");
}

describe("a committed send", () => {
	it("is delivered once, acknowledged durably, and the ack is what stops a second send", async () => {
		const served = await serveConnector({ steps: replyTurns(["only once"]) });
		try {
			const connected = await connectConnector(served);
			try {
				await say(connected, "hello");
				await until(async () => (await acks(served)).length === 1, "the acknowledgement");
				const ack = (await acks(served))[0] as { deliveryId: string; status: string };
				assert.equal(ack.status, "delivered");
				assert.equal(ack.deliveryId, connected.deliveries[0]?.deliveryId);
				const before = connected.deliveries.length;
				await served.server.connectors.flush();
				assert.equal(connected.deliveries.length, before, "an acknowledged send is not owed again");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("reaches one destination: the address the turn came from, and not the other connector", async () => {
		const home = await connectorHome({ second: true });
		const served = await serveConnector({ home, steps: replyTurns(["to the team chat"]) });
		try {
			const telegram = await connectConnector(served);
			const slack = await connectConnector(served, {
				name: "slack",
				credential: home.secondCredential as string,
			});
			try {
				await say(telegram, "hello");
				await until(() => telegram.deliveries.length === 1, "the send to the connector that wrote");
				await served.server.connectors.flush();
				assert.equal(slack.deliveries.length, 0, "a connector that never wrote was sent nothing");
			} finally {
				await telegram.close();
				await slack.close();
			}
		} finally {
			await served.close();
		}
	});

	it("is resent under the same deliveryId when its answer was lost, and the ledger answers duplicate", async () => {
		const served = await serveConnector({ steps: replyTurns(["maybe once"]) });
		try {
			let attempts = 0;
			let dropped = false;
			const sent: string[] = [];
			const connected = await connectConnector(served, {
				handlers: {
					onDelivery: (delivery) => {
						attempts += 1;
						sent.push(delivery.deliveryId);
						// The first attempt settles and its answer never arrives: the link goes down between the ledger
						// write and the result. That is the only state in which a resend proves anything.
						if (!dropped) {
							dropped = true;
							connected.connector.drop("the answer was lost");
						}
						return { status: "delivered", detail: delivery.deliveryId };
					},
				},
			});
			try {
				await say(connected, "hello");
				await until(async () => (await acks(served)).length === 1, "the acknowledgement of the resend", 10_000);
				assert.equal((await acks(served))[0]?.status, "duplicate");
				assert.equal(attempts, 1, "the medium sent it once: the ledger turned the resend into a duplicate");
				assert.equal(sent.length, 1, "the delivery id the medium saw");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("is never retried when the connector reports it may have happened", async () => {
		const served = await serveConnector({ steps: replyTurns(["maybe"]) });
		try {
			let attempts = 0;
			const connected = await connectConnector(served, {
				handlers: {
					onDelivery: () => {
						attempts += 1;
						throw new Error("the vendor stopped answering");
					},
				},
			});
			try {
				await say(connected, "hello");
				await until(async () => (await acks(served)).length === 1, "the acknowledgement");
				assert.equal((await acks(served))[0]?.status, "uncertain");
				await served.server.connectors.flush();
				await served.server.connectors.flush();
				assert.equal(attempts, 1, "an uncertain send is never attempted twice");
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
				handlers: {
					onDelivery: () => ({ status: "uncertain", detail: "the network dropped it" }),
				},
			});
			try {
				await say(connected, "hello");
				await until(async () => (await acks(served)).length === 1, "the acknowledgement");
				const { projectTranscript } = await import("../src/server/projection.ts");
				const conversation = await served.server.runtime.conversation();
				const view = await served.server.runtime.viewSnapshot(
					(await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT,
				);
				void conversation;
				const items = projectTranscript(view);
				assert.ok(
					items.some((item) => item.kind === "notice" && /may not have reached/.test(item.text)),
					`the transcript says the message may not have arrived: ${JSON.stringify(items)}`,
				);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("a send nobody can reach", () => {
	it("is recorded and reported, and the transcript still holds it", async () => {
		const served = await serveConnector({ steps: replyTurns(["nobody is listening"]) });
		try {
			const connected = await connectConnector(served);
			try {
				await connected.connector.event({ appendId: "quiet-1", kind: "chat.message", payload: "ring" });
				await until(async () => (await entries(served, REPLY_ENTRY_KIND)).length === 1, "the recorded send");
				await served.server.connectors.flush();
				assert.equal(connected.deliveries.length, 0, "nothing was delivered");
				assert.match(JSON.stringify(await entriesOf(served.server)), /nobody was reached/);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});
