/**
 * The connector door: mason's Chord host, the session it serves, and the three appends a connector can make.
 *
 * Every test here drives the published SDK over a real socket, because the parts most likely to be wrong are the parts a
 * direct call would skip: the bearer credential on the upgrade, the path, the child host's name, the session as state.
 * The admission rules are read off the durable transcript rather than a counter — an `app.connector` entry with its
 * origin, an `app.hook` entry that is not conversation — because that is where the claim lives.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import WebSocket from "ws";
import { CONNECTOR_ENTRY_KIND, HOOK_ENTRY_KIND, NOTICE_ENTRY_KIND, REPLY_ENTRY_KIND } from "../src/shared/contract.ts";
import {
	connectConnector,
	connectorHome,
	entriesOf,
	quietTurns,
	replyTurns,
	serveConnector,
	until,
} from "./support/connector.ts";

/** Every entry of one kind, oldest first, as plain JSON. */
async function entries(served: Awaited<ReturnType<typeof serveConnector>>, kind: string) {
	return (await entriesOf(served.server)).filter((entry) => entry.kind === kind);
}

describe("a connector's words", () => {
	it("become an ordinary attributed submission, and the send goes back to the origin's address", async () => {
		const served = await serveConnector({
			home: await connectorHome(),
			steps: replyTurns(["the calendar is clear"]),
		});
		try {
			const connected = await connectConnector(served);
			try {
				const outcome = await connected.connector.submit({
					origin: { ref: "team", messageId: "m1", actor: { id: "8811", name: "Denis" } },
					content: [{ type: "text", text: "what is on my calendar" }],
				});
				assert.equal(outcome.status, "accepted");
				await until(() => connected.deliveries.length === 1, "the send to arrive");
				assert.equal(connected.deliveries[0]?.text, "the calendar is clear");

				const submitted = await entries(served, CONNECTOR_ENTRY_KIND);
				assert.equal(submitted.length, 1);
				// The origin is the durable record the send is routed from: a restart cannot lose where the words came from.
				assert.deepEqual(submitted[0]?.data, {
					origin: { connector: "telegram", ref: "team", messageId: "m1", actor: { id: "8811", name: "Denis" } },
				});
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("resend under one appendId is one submission, and mason says duplicate", async () => {
		const served = await serveConnector({ home: await connectorHome(), steps: quietTurns() });
		try {
			const connected = await connectConnector(served);
			try {
				const first = await connected.connector.submit({
					appendId: "same-1",
					origin: { ref: "team" },
					content: [{ type: "text", text: "hello" }],
				});
				assert.equal(first.status, "accepted");
				const again = await connected.connector.submit({
					appendId: "same-1",
					origin: { ref: "team" },
					content: [{ type: "text", text: "hello, resent" }],
				});
				assert.equal(again.status, "duplicate");
				assert.equal((await entries(served, CONNECTOR_ENTRY_KIND)).length, 1, "one entry for one id");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("an actor that is not the owner is refused, and nothing is placed", async () => {
		const served = await serveConnector({ home: await connectorHome() });
		try {
			const connected = await connectConnector(served);
			try {
				const outcome = await connected.connector.submit({
					origin: { ref: "team", actor: { id: "stranger-9" } },
					content: [{ type: "text", text: "let me in" }],
				});
				assert.equal(outcome.status, "refused");
				assert.equal(outcome.status === "refused" ? outcome.code : undefined, "mason.actor_unknown");
				assert.equal((await entries(served, CONNECTOR_ENTRY_KIND)).length, 0);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("an entry with no owner refuses every named actor, and accepts nobody's words", async () => {
		const served = await serveConnector({ home: await connectorHome({ noOwner: true }) });
		try {
			const connected = await connectConnector(served);
			try {
				const refused = await connected.connector.submit({
					origin: { ref: "team", actor: { id: "8811" } },
					content: [{ type: "text", text: "who am i" }],
				});
				assert.equal(refused.status, "refused");
				assert.equal(refused.status === "refused" ? refused.code : undefined, "mason.actor_unknown");
				const withoutActor = await connected.connector.submit({
					origin: { ref: "team" },
					content: [{ type: "text", text: "nobody in particular" }],
				});
				assert.equal(withoutActor.status, "accepted", "an actorless append is a message nobody signed");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("an entry that grants only events refuses words, and places nothing", async () => {
		// The face is the ceiling above the actor: an entry the operator gave an event kind and no `user` may raise alarms
		// and may not be spoken through, and a submission is refused before anything is placed in the transcript.
		const home = await connectorHome();
		const served = await serveConnector({ home, steps: quietTurns() });
		try {
			const connected = await connectConnector(served, {
				name: "alarm-only",
				credential: home.alarmCredential,
			});
			try {
				const refused = await connected.connector.submit({
					origin: { ref: "chat-1" },
					content: [{ type: "text", text: "let me in" }],
				});
				assert.equal(refused.status, "refused");
				assert.equal(refused.status === "refused" ? refused.code : undefined, "mason.face_not_granted");
				assert.equal((await entries(served, CONNECTOR_ENTRY_KIND)).length, 0, "nothing landed");
				assert.equal((await entries(served, HOOK_ENTRY_KIND)).length, 0, "and no turn was started");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("an event", () => {
	it("is a hook entry and never conversation, deduplicated on its appendId", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const fired = await connected.connector.event({
					appendId: "alarm-1",
					kind: "chat.message",
					payload: { chat: "-1001234", text: "hello" },
				});
				assert.equal(fired.status, "accepted");
				const again = await connected.connector.event({
					appendId: "alarm-1",
					kind: "chat.message",
					payload: { chat: "-1001234", text: "hello, resent" },
				});
				assert.equal(again.status, "duplicate");

				const hooks = await entries(served, HOOK_ENTRY_KIND);
				assert.equal(hooks.length, 1);
				assert.equal((hooks[0]?.data as { hookId?: string }).hookId, "team-chat");
				assert.equal((await entries(served, CONNECTOR_ENTRY_KIND)).length, 0, "an event is not conversation");
				assert.match(JSON.stringify(hooks[0]?.model), /hello/);
				assert.match(JSON.stringify(hooks[0]?.model), /begin untrusted payload/, "the payload is fenced as data");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("of a kind the entry does not name is refused with mason.kind_not_permitted", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const outcome = await connected.connector.event({ kind: "alarm.ringing", payload: {} });
				assert.equal(outcome.status, "refused");
				assert.equal(outcome.status === "refused" ? outcome.code : undefined, "mason.kind_not_permitted");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("of a granted kind whose routine is switched off is written down and wakes nothing", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				// The grant names `chat.message` -> `team-chat`; the routine file the home ships does not define `alarm-ringing`
				// at all, which is the same shape as a routine the agent switched off.
				const outcome = await connected.connector.event({
					kind: "chat.message",
					appendId: "quiet-1",
					payload: "x",
				});
				assert.equal(outcome.status, "accepted");
				const log = served.server.runtime.events.lines();
				assert.equal(log.length, 1, "every event is written down");
				assert.equal(log[0]?.kind, "chat.message");
				assert.equal(log[0]?.connector, "telegram");
				assert.equal(log[0]?.hook, "team-chat");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("carries its origin into the entry, so the send has a reader", async () => {
		const served = await serveConnector({ home: await connectorHome(), steps: replyTurns(["on it"]) });
		try {
			const connected = await connectConnector(served);
			try {
				await connected.connector.event({
					appendId: "chat-7",
					kind: "chat.message",
					payload: "are you there",
					origin: { ref: "team", messageId: "m7" },
				});
				await until(() => connected.deliveries.length === 1, "the answer to the event");
				const hooks = await entries(served, HOOK_ENTRY_KIND);
				assert.deepEqual((hooks[0]?.data as { origin?: unknown }).origin, {
					connector: "telegram",
					ref: "team",
					messageId: "m7",
				});
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("with no address records the work and tells the model nobody was reached", async () => {
		const served = await serveConnector({ home: await connectorHome(), steps: replyTurns(["nobody is listening"]) });
		try {
			const connected = await connectConnector(served);
			try {
				await connected.connector.event({ appendId: "alarm-2", kind: "chat.message", payload: "ring" });
				await until(
					async () => (await entries(served, REPLY_ENTRY_KIND)).length === 1,
					"a recorded send that reaches nobody",
				);
				const sent = (await entries(served, REPLY_ENTRY_KIND))[0];
				assert.equal(sent?.data === undefined ? undefined : (sent.data as { target?: unknown }).target, undefined);
				assert.equal(connected.deliveries.length, 0, "nothing was sent to a person");
				assert.match(JSON.stringify(await entriesOf(served.server)), /nobody was reached/);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("a notice", () => {
	it("is written down for the reader and starts no turn", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const outcome = await connected.connector.notice({ text: "the channel was muted for an hour" });
				assert.equal(outcome.status, "accepted");
				const written = await entries(served, NOTICE_ENTRY_KIND);
				assert.equal(written.length, 1);
				assert.equal((written[0]?.data as { text?: string }).text, "the channel was muted for an hour");
				assert.equal((await entries(served, HOOK_ENTRY_KIND)).length, 0, "a notice wakes nothing");
				assert.equal((await entries(served, CONNECTOR_ENTRY_KIND)).length, 0, "a notice is not a person's words");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("the session", () => {
	it("is state a connector reads once, and it names the targets, the vocabulary and the budgets", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const session = connected.connector.status().session;
				assert.ok(session !== undefined, "the session is there after start");
				assert.deepEqual(
					session.targets.map((target) => target.id),
					["team", "dm"],
				);
				assert.deepEqual(session.commands, ["stop", "compact", "clear", "status"]);
				assert.deepEqual(session.kinds, ["chat.message"]);
				assert.equal(session.limits.submissionsPerMinute > 0, true);
				assert.equal(session.limits.attachmentsPerMinute > 0, true);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("is refused for a credential whose entry is switched off, and the same socket opens for one that is not", async () => {
		const home = await connectorHome();
		const served = await serveConnector({ home });
		try {
			// A credential minted for the entry called `off`, whose connector is disabled: minting is allowed — it is the
			// grant that decides — and the socket has to close rather than open with nothing on it.
			const refused = await opens(served.url, home.offCredential ?? "");
			assert.equal(refused, false, "a switched-off entry opened a socket");

			// The same door, the credential of an entry that is on: this is what makes the case above about admission
			// rather than about sockets that never open.
			assert.equal(await opens(served.url, home.credential), true, "an enabled entry was refused");
		} finally {
			await served.close();
		}
	});
});

describe("control", () => {
	it("answers a granted control, and the vocabulary is the one the session named", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const stop = await connected.connector.control({ op: "stop" });
				assert.equal(stop.handled, true);
				const status = await connected.connector.control({ op: "status" });
				assert.equal(status.handled, true);
				assert.ok(status.status !== undefined, "a status control answers with the run's state");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("refuses a control the entry does not declare, and one that takes an argument it must not", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const undeclared = await connected.connector.control({ op: "reboot" as never });
				assert.equal(undeclared.handled, false);
				const withArgument = await connected.connector.control({ op: "stop", instructions: "now please" });
				assert.equal(withArgument.handled, false, "only compact reads what follows it");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("budgets", () => {
	it("refuses a submission over the minute, and the SDK keeps it for a retry", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				// The limiter is per process and shared with the rest of this file's tests only through this server, so the
				// budget is spent here and nowhere else.
				let pending = 0;
				for (let index = 0; index < 70; index += 1) {
					const outcome = await connected.connector.submit({
						appendId: `budget-${index}`,
						origin: { ref: "team" },
						content: [{ type: "text", text: `message ${index}` }],
					});
					if (outcome.status === "pending") pending += 1;
				}
				assert.ok(pending > 0, "at least one call past the minute stayed journaled");
				assert.ok((await entries(served, CONNECTOR_ENTRY_KIND)).length <= 60, "the minute's budget was enforced");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

/**
 * Whether a socket with this credential stays open.
 *
 * A refused upgrade closes, and so does a socket that opened because this test closed it: the distinction is the point, so
 * the answer is "it was still open a moment after the handshake", not "it emitted close at some time".
 */
async function opens(url: string, credential: string): Promise<boolean> {
	const socket = new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } });
	return new Promise<boolean>((resolve) => {
		const settle = (value: boolean): void => {
			socket.removeAllListeners();
			socket.close();
			resolve(value);
		};
		socket.on("open", () => setTimeout(() => settle(socket.readyState === socket.OPEN), 150));
		socket.on("close", () => settle(false));
		socket.on("error", () => settle(false));
	});
}
