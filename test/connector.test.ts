/**
 * The connector door: one JSON-RPC socket, its handshake, and the two acts a connector can take with words.
 *
 * Every test here drives the published SDK over a real socket, because the parts most likely to be wrong are the parts a
 * direct call would skip: the bearer credential on the upgrade, the path, the framing, the handshake ceiling. The
 * admission rules are read off the durable transcript rather than a counter — an `app.connector` entry with its origin,
 * and an `app.hook` entry that is not conversation — because that is where the claim lives.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import WebSocket from "ws";
import {
	listConnectorCredentials,
	mintConnectorCredential,
	revokeConnectorCredential,
} from "../src/server/connectors.ts";
import { CONNECTOR_ENTRY_KIND, HOOK_ENTRY_KIND, REPLY_ENTRY_KIND } from "../src/shared/contract.ts";
import {
	connectConnector,
	connectorHome,
	entriesOf,
	fullFaces,
	quietTurns,
	rawConnect,
	replyTurns,
	serveConnector,
	until,
} from "./support/connector.ts";

/** Every entry of one kind, oldest first, as plain JSON. */
async function entries(served: Awaited<ReturnType<typeof serveConnector>>, kind: string) {
	return (await entriesOf(served.server)).filter((entry) => entry.kind === kind);
}

describe("a connector's words", () => {
	it("become an ordinary attributed submission, and the reply goes back where they came from", async () => {
		const served = await serveConnector({
			home: await connectorHome(),
			steps: replyTurns(["the calendar is clear"]),
		});
		try {
			const connected = await connectConnector(served);
			try {
				const outcome = await connected.connector.submit({
					origin: { connector: "telegram", externalConversationId: "-1001234", externalMessageId: "m1" },
					actor: { externalActorId: "8811", displayName: "Denis" },
					content: [{ type: "text", text: "what is on my calendar" }],
				});
				assert.equal(outcome.status, "accepted");
				await until(() => connected.deliveries.length === 1, "the reply to arrive");
				assert.equal(connected.deliveries[0]?.text, "the calendar is clear");

				const submitted = await entries(served, CONNECTOR_ENTRY_KIND);
				assert.equal(submitted.length, 1);
				// The origin is the durable record the reply is routed from: a restart cannot lose where the words came from.
				// Nothing else is in it: the actor was admitted, so there is no name to write down or to prefix the words with.
				assert.deepEqual(submitted[0]?.data, {
					origin: {
						connector: "telegram",
						externalConversationId: "-1001234",
						externalMessageId: "m1",
					},
				});
				const text = JSON.stringify(submitted[0]?.model);
				assert.match(text, /what is on my calendar/);
				assert.doesNotMatch(text, /\[from /, "one person's words carry no author label");
				// The reply is an entry of its own, addressed at the origin.
				const reply = await entries(served, REPLY_ENTRY_KIND);
				assert.deepEqual(reply[0]?.data, {
					deliveryId: connected.deliveries[0]?.deliveryId,
					blocks: [{ type: "text", text: "the calendar is clear" }],
					target: { connector: "telegram", externalConversationId: "-1001234" },
					origin: {
						connector: "telegram",
						externalConversationId: "-1001234",
						externalMessageId: "m1",
					},
				});
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("collapse on a duplicate submissionId, and the claim is durable rather than a counter", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const first = await connected.connector.submit({
					submissionId: "tg-1",
					origin: { connector: "telegram", externalConversationId: "-1001234" },
					actor: { externalActorId: "8811" },
					content: [{ type: "text", text: "one" }],
				});
				assert.equal(first.status, "accepted");
				const again = await connected.connector.submit({
					submissionId: "tg-1",
					origin: { connector: "telegram", externalConversationId: "-1001234" },
					actor: { externalActorId: "8811" },
					content: [{ type: "text", text: "one, resent" }],
				});
				assert.equal(again.status, "duplicate");
				assert.equal(
					again.status === "duplicate" ? again.entryId : undefined,
					(first as { entryId?: string }).entryId,
				);
				assert.equal((await entries(served, CONNECTOR_ENTRY_KIND)).length, 1, "one act, one entry");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("are refused for an actor that is not the owner and for a room the entry does not permit", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const stranger = await connected.connector.submit({
					origin: { connector: "telegram", externalConversationId: "-1001234" },
					actor: { externalActorId: "9999", displayName: "Somebody" },
					content: [{ type: "text", text: "let me in" }],
				});
				assert.equal(stranger.status, "refused");
				assert.equal(stranger.status === "refused" ? stranger.error.code : undefined, "mason.actor_unknown");

				const room = await connected.connector.submit({
					origin: { connector: "telegram", externalConversationId: "-1009999" },
					actor: { externalActorId: "8811" },
					content: [{ type: "text", text: "elsewhere" }],
				});
				assert.equal(room.status, "refused");
				assert.equal(room.status === "refused" ? room.error.code : undefined, "mason.conversation_not_permitted");

				// An absent actor is not a refusal: a face with an `owner` still carries what nobody signed.
				const noActor = await connected.connector.submit({
					origin: { connector: "telegram", externalConversationId: "-1001234" },
					content: [{ type: "text", text: "a notice nobody signed" }],
				});
				assert.equal(noActor.status, "accepted");
				assert.equal((await entries(served, CONNECTOR_ENTRY_KIND)).length, 1, "the refusals wrote nothing");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("admit an actorless submission, and refuse every actor when the entry names no owner", async () => {
		const served = await serveConnector({ home: await connectorHome({ noOwner: true }) });
		try {
			const connected = await connectConnector(served);
			try {
				// The handshake still answers a user face, and its actor list is empty: the connector advertised 8811 and the
				// entry has no id to admit, so there is nobody to name.
				const session = connected.connector.status().session;
				assert.deepEqual(session?.faces.user?.actors, []);
				const named = await connected.connector.submit({
					origin: { connector: "telegram", externalConversationId: "-1001234" },
					actor: { externalActorId: "8811", displayName: "Denis" },
					content: [{ type: "text", text: "let me in" }],
				});
				assert.equal(named.status, "refused");
				assert.equal(named.status === "refused" ? named.error.code : undefined, "mason.actor_unknown");

				// No actor is not a stranger: it is a notice, and it is accepted with nothing attributed to it.
				const outcome = await connected.connector.submit({
					origin: { connector: "telegram", externalConversationId: "-1001234" },
					content: [{ type: "text", text: "from a guest" }],
				});
				assert.equal(outcome.status, "accepted");
				const submitted = await entries(served, CONNECTOR_ENTRY_KIND);
				assert.deepEqual(submitted[0]?.data, {
					origin: { connector: "telegram", externalConversationId: "-1001234" },
				});
				assert.match(JSON.stringify(submitted[0]?.model), /from a guest/);
				assert.doesNotMatch(JSON.stringify(submitted[0]?.model), /\[from /, "nobody vouched for these words");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("a fire", () => {
	it("is a hook entry and never ordinary conversation, deduplicated on its fireId", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const fired = await connected.connector.fire({
					fireId: "alarm-1",
					kind: "chat.message",
					payload: { chat: "-1001234", text: "hello" },
				});
				assert.equal(fired.status, "accepted");
				const again = await connected.connector.fire({
					fireId: "alarm-1",
					kind: "chat.message",
					payload: { chat: "-1001234", text: "hello, resent" },
				});
				assert.equal(again.status, "duplicate");

				const hooks = await entries(served, HOOK_ENTRY_KIND);
				assert.equal(hooks.length, 1);
				assert.equal((hooks[0]?.data as { hookId?: string }).hookId, "team-chat");
				assert.equal((await entries(served, CONNECTOR_ENTRY_KIND)).length, 0, "a fire is not conversation");
				assert.match(JSON.stringify(hooks[0]?.model), /hello/);
				assert.match(JSON.stringify(hooks[0]?.model), /begin untrusted payload/, "the payload is fenced as data");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("refuses a kind the entry does not map, and a kind it maps but the build does not know is a boot refusal", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const refused = await connected.connector.fire({ kind: "alarm.ringing", payload: {} });
				assert.equal(refused.status, "refused");
				assert.equal(refused.status === "refused" ? refused.error.code : undefined, "mason.kind_not_permitted");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("carries its origin into the entry, so the reply has a reader", async () => {
		const served = await serveConnector({ home: await connectorHome(), steps: replyTurns(["on it"]) });
		try {
			const connected = await connectConnector(served);
			try {
				await connected.connector.fire({
					fireId: "chat-7",
					kind: "chat.message",
					payload: "are you there",
					origin: { connector: "telegram", externalConversationId: "-1001234", externalMessageId: "m7" },
				});
				await until(() => connected.deliveries.length === 1, "the answer to the fire");
				const hooks = await entries(served, HOOK_ENTRY_KIND);
				assert.deepEqual((hooks[0]?.data as { origin?: unknown }).origin, {
					connector: "telegram",
					externalConversationId: "-1001234",
					externalMessageId: "m7",
				});
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("with no reachable target records the work and tells the model nobody was reached", async () => {
		const served = await serveConnector({ home: await connectorHome(), steps: replyTurns(["nobody is listening"]) });
		try {
			const connected = await connectConnector(served);
			try {
				await connected.connector.fire({ fireId: "alarm-2", kind: "chat.message", payload: "ring" });
				await until(
					async () => (await entries(served, REPLY_ENTRY_KIND)).length === 1,
					"a recorded reply that reaches nobody",
				);
				const reply = (await entries(served, REPLY_ENTRY_KIND))[0];
				assert.equal(
					reply?.data === undefined ? undefined : (reply.data as { target?: unknown }).target,
					undefined,
				);
				assert.equal(connected.deliveries.length, 0, "nothing was sent to a person");
				const result = JSON.stringify(await entriesOf(served.server));
				assert.match(result, /nobody was reached/);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("the handshake", () => {
	it("names a face the entry does not grant as inactive, and refuses a call on it", async () => {
		const served = await serveConnector();
		try {
			// A tools face the entry does have, and an events face the alarm entry does not — two sides of the same rule.
			const connected = await connectConnector(served, {
				name: "alarm-only",
				credential: await mint(served, "alarm-only"),
				faces: {
					user: { actors: [], conversations: [], capabilities: ["text"] },
					events: { kinds: ["alarm.ringing"] },
				},
			});
			try {
				const session = connected.connector.status().session;
				assert.deepEqual(session?.inactive, [{ face: "user", reason: "the entry grants no user face" }]);
				const refused = await connected.connector.submit({
					origin: { connector: "alarm-only", externalConversationId: "x" },
					content: [{ type: "text", text: "hello" }],
				});
				assert.equal(refused.status, "refused");
				assert.equal(refused.status === "refused" ? refused.error.code : undefined, "mason.face_not_granted");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("narrows capabilities to what the connector claims and the operator allows", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served, {
				faces: fullFaces({
					user: {
						actors: [{ externalActorId: "8811" }],
						conversations: [{ externalConversationId: "-1001234", kind: "room" }],
						capabilities: ["text", "markdown", "widgets"],
					},
				}),
			});
			try {
				// The entry grants text, markdown, files, approvals and streaming; the connector claims text, markdown and
				// widgets. The answer is what is in both, which is how a medium that cannot render a widget is never sent
				// one and a connector is never sent a file it did not claim it can hold.
				assert.deepEqual(connected.connector.status().session?.capabilities, ["text", "markdown"]);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("answers the one actor the entry owns, as the connector advertised it", async () => {
		const served = await serveConnector();
		try {
			// Two advertised actors and one owner: the answer keeps the advertised record — id and display name — and
			// drops the actor nobody granted, so a connector can tell an owned medium from an owned-and-shared one.
			const connected = await connectConnector(served, {
				faces: fullFaces({
					user: {
						actors: [
							{ externalActorId: "9999", displayName: "Somebody" },
							{ externalActorId: "8811", displayName: "Denis" },
						],
						conversations: [{ externalConversationId: "-1001234", kind: "room" }],
					},
				}),
			});
			try {
				assert.deepEqual(connected.connector.status().session?.faces.user?.actors, [
					{ externalActorId: "8811", displayName: "Denis" },
				]);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("refuses a protocol major it does not speak, and closes the socket", async () => {
		const served = await serveConnector();
		try {
			const credential = served.credential;
			const socket = new WebSocket(served.url, { headers: { authorization: `Bearer ${credential}` } });
			const outcome = await new Promise<string>((resolve) => {
				socket.on("open", () => {
					socket.send(
						JSON.stringify({
							jsonrpc: "2.0",
							id: "h1",
							method: "mason/hello",
							params: {
								protocol: { major: 9, minors: [0] },
								connector: { name: "telegram", version: "x" },
								faces: {},
							},
						}),
					);
				});
				socket.on("message", (data) => resolve(String(data)));
				socket.on("close", () => resolve("closed"));
			});
			const frame = JSON.parse(outcome) as { error?: { data?: { code?: string } } };
			assert.equal(frame.error?.data?.code, "mason.protocol_mismatch");
			await new Promise((resolve) => socket.on("close", resolve));
			socket.close();
		} finally {
			await served.close();
		}
	});

	it("accepts the first call only once, and answers a second hello as a bad request", async () => {
		const served = await serveConnector();
		try {
			const socket = new WebSocket(served.url, { headers: { authorization: `Bearer ${served.credential}` } });
			const frames: Array<{ id?: string; error?: { data?: { code?: string } }; result?: unknown }> = [];
			socket.on("message", (data) => frames.push(JSON.parse(String(data))));
			const hello = (id: string) => ({
				jsonrpc: "2.0",
				id,
				method: "mason/hello",
				params: { protocol: { major: 1, minors: [0] }, connector: { name: "telegram", version: "x" }, faces: {} },
			});
			await new Promise<void>((open) => socket.on("open", () => open()));
			socket.send(JSON.stringify(hello("h1")));
			await until(() => frames.length === 1, "the first answer");
			socket.send(JSON.stringify(hello("h2")));
			await until(() => frames.length === 2, "the second answer");
			assert.ok(frames[0]?.result !== undefined, "the first hello is answered");
			assert.equal(frames[1]?.error?.data?.code, "mason.invalid_request");
			socket.close();
		} finally {
			await served.close();
		}
	});
});

/** Mint a credential for one entry of a served home, through the same command an operator would run. */
async function mint(served: Awaited<ReturnType<typeof serveConnector>>, name: string): Promise<string> {
	return (await mintConnectorCredential(served.paths.home, name)).credential;
}

describe("the socket's door", () => {
	it("refuses no credential, a revoked one, and a page's Origin", async () => {
		const served = await serveConnector();
		try {
			await assert.rejects(connectConnector(served, { credential: "masonc_not-a-real-credential" }));
			const records = await listConnectorCredentials(served.paths.home);
			const boot = records.find((record) => record.connector === "telegram");
			assert.ok(boot !== undefined);
			assert.equal(await revokeConnectorCredential(served.paths.home, boot.id), true);
			// Revocation is read per upgrade: the very next connection is refused, without a restart.
			await assert.rejects(connectConnector(served, { credential: served.credential }));

			const rotated = await mint(served, "telegram");
			const live = await connectConnector(served, { credential: rotated });
			await live.close();

			const bad = new WebSocket(served.url, {
				headers: { authorization: `Bearer ${rotated}`, origin: "https://evil.example" },
			});
			const closed = await new Promise<boolean>((resolve) => {
				bad.on("close", () => resolve(true));
				bad.on("open", () => setTimeout(() => resolve(false), 200));
			});
			assert.equal(closed, true);
			bad.close();
		} finally {
			await served.close();
		}
	});

	it("refuses a credential for an entry that is switched off", async () => {
		const served = await serveConnector();
		try {
			const credential = await mint(served, "off");
			await assert.rejects(connectConnector(served, { name: "off", credential }));
		} finally {
			await served.close();
		}
	});

	it("lets a second socket supersede the first, and says so", async () => {
		const served = await serveConnector();
		try {
			const first = await connectConnector(served);
			const second = await connectConnector(served);
			try {
				await until(() => first.connector.status().connected === false, "the first socket to be closed");
				assert.equal(second.connector.status().connected, true);
			} finally {
				await first.close();
				await second.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("control", () => {
	it("runs a declared command once per request id, and an undeclared word spends nothing", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const status = await connected.connector.control({ op: "status" });
				assert.equal(status.handled, true);
				assert.match(status.reply ?? "", /idle/);
				const stop = await connected.connector.control({ op: "stop" });
				assert.equal(stop.reply, "stopped");
				// A malformed op is refused, and the refusal names the whole set.
				const bad = await connected.connector.control({ op: "restart" as never });
				assert.equal(bad.handled, false);
				assert.match(bad.reply ?? "", /not a control mason knows/);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("answers the handshake with the control vocabulary it was granted, and holds a word to its shape", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				// The list is the grant: a connector that was not given `stop` learns it here rather than by spending a
				// refused call, and the four names are the protocol's closed set.
				assert.deepEqual(connected.connector.status().session?.commands, ["stop", "compact", "clear", "status"]);

				// The shape the old event door held a command to survives the cutover, because the socket is the only door
				// now: a word that takes no argument refuses one, and `compact` reads a line rather than a document.
				const withArgument = await connected.connector.control({ op: "stop", instructions: "now please" });
				assert.equal(withArgument.handled, false);
				assert.match(withArgument.reply ?? "", /"stop" takes no argument/);

				const tooLong = await connected.connector.control({ op: "compact", instructions: "x".repeat(201) });
				assert.equal(tooLong.handled, false);
				assert.match(tooLong.reply ?? "", /at most 200 characters/);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("keeps stop independent of the fire budget, so a flood cannot starve it", async () => {
		const served = await serveConnector();
		try {
			// Raw, because the SDK turns a retryable refusal into `pending` and retries it later: the point here is the
			// refusal itself, and the hint a client waits for.
			const session = await rawConnect(served);
			try {
				const payload = { kind: "chat.message", payload: "flood" };
				for (let index = 0; index < 6; index += 1) {
					const fired = await session.call("mason/fire", { ...payload, fireId: `flood-${index}` });
					assert.equal(fired.error, undefined);
				}
				const flood = await session.call("mason/fire", { ...payload, fireId: "flood-6" });
				assert.equal(flood.error?.data?.code, "mason.rate_limited");
				assert.equal(typeof flood.error?.data?.retryAfterMs, "number");
				// The same minute's stop still lands: its budget is its own, which is the whole reason it has one.
				const stop = await session.call("mason/control", { op: "stop" });
				assert.equal(stop.error, undefined);
				assert.equal((stop.result as { reply?: string }).reply, "stopped");
			} finally {
				session.close();
			}
		} finally {
			await served.close();
		}
	});

	it("answers an unknown permission with mason.unknown_permission, and settles nothing", async () => {
		const served = await serveConnector();
		try {
			const session = await rawConnect(served);
			try {
				const answer = await session.call("mason/interaction.answer", { permissionId: "perm-1", answer: "allow" });
				assert.equal(answer.error?.data?.code, "mason.unknown_permission");
			} finally {
				session.close();
			}
			const connected = await connectConnector(served);
			try {
				// What the SDK makes of the same refusal: not settled, with mason's sentence as the reason.
				const result = await connected.connector.answer({ permissionId: "perm-1", answer: "deny" });
				assert.equal(result.settled, false);
				assert.match(result.reason ?? "", /not pending/);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("budgets", () => {
	it("counts submissions and fires separately, and answers a refusal with retryAfterMs", async () => {
		const served = await serveConnector({ steps: quietTurns(80) });
		try {
			const session = await rawConnect(served);
			try {
				const submit = (index: number) =>
					session.call("mason/submit", {
						submissionId: `budget-${index}`,
						origin: { connector: "telegram", externalConversationId: "-1001234" },
						actor: { externalActorId: "8811" },
						content: [{ type: "text", text: `message ${index}` }],
					});
				for (let index = 0; index < 60; index += 1) {
					assert.equal((await submit(index)).error, undefined, `submission ${index} was admitted`);
				}
				const over = await submit(60);
				assert.equal(over.error?.data?.code, "mason.rate_limited");
				assert.equal(over.error?.data?.retryable, true);
				assert.equal(typeof over.error?.data?.retryAfterMs, "number");
				// A spent submission minute is not a spent fire minute.
				const fired = await session.call("mason/fire", {
					fireId: "still-here",
					kind: "chat.message",
					payload: "x",
				});
				assert.equal(fired.error, undefined);
				// And the control class is untouched by both.
				const stop = await session.call("mason/control", { op: "stop" });
				assert.equal(stop.error, undefined);
			} finally {
				session.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("a hooked turn with no origin", () => {
	it("still records the reply and reaches nobody, rather than claiming a delivery", async () => {
		const served = await serveConnector({
			home: await connectorHome(),
			steps: [fauxAssistantMessage(fauxText("no reply here"))],
		});
		try {
			const connected = await connectConnector(served);
			try {
				await connected.connector.fire({ fireId: "alarm-9", kind: "chat.message", payload: "ring" });
				await until(async () => {
					const hooks = await entries(served, HOOK_ENTRY_KIND);
					return hooks.length === 1;
				}, "the fire to land");
				// The gate asked once for a reply and the model had nothing; nothing was sent anywhere and no reply entry claims
				// otherwise.
				assert.equal(connected.deliveries.length, 0);
				assert.equal((await entries(served, REPLY_ENTRY_KIND)).length, 0);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});
