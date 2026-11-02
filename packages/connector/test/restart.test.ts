import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Connector, createConnector } from "../src/connector.ts";
import { openSqliteStore } from "../src/store-sqlite.ts";
import { createFakeMason, type FakeMason } from "../src/testkit/fake-mason.ts";
import { chat } from "./fixtures/chat.ts";

/**
 * The two claims the README makes about a restart: two connector instances, one store file, and in between them nothing
 * but what reached the disk.
 *
 * The store is the only thing carried over. Everything a connector keeps in memory — its socket, its in-flight map, the
 * set of ids it has seen — is gone, which is exactly why the journal and the ledger have to live in the store. The two
 * instances share this process because that is what a test can do; the state they share is only the file.
 */
async function withFixture(
	act: (context: {
		readonly mason: FakeMason;
		readonly path: string;
		open: () => Promise<{ connector: Connector; sends: number[] }>;
	}) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "connector-restart-"));
	const mason = createFakeMason({
		connector: chat.name,
		granted: {
			user: {
				actors: chat.faces.user?.actors ?? [],
				conversations: chat.faces.user?.conversations ?? [],
				capabilities: chat.faces.user?.capabilities ?? ["text"],
			},
			tools: { url: "https://chat.internal/mcp" },
			events: { "chat.message": "chat-message" },
			state: ["status"],
		},
		capabilities: chat.faces.user?.capabilities ?? ["text"],
	});
	mason.start();
	const path = join(dir, "connector.db");

	const open = async () => {
		const store = await openSqliteStore({ path });
		const sends: number[] = [];
		const connector = createConnector({
			name: chat.name,
			version: "1.0.0",
			url: mason.url,
			credential: "test-credential",
			store,
			link: mason.link,
			fetch: mason.fetch,
			requestTimeoutMs: 1_000,
			reconnect: { initialMs: 1, maxMs: 5 },
			heartbeatMs: 0,
			faces: { user: chat.faces.user, tools: chat.faces.tools, events: { kinds: ["chat.message"] } },
			handlers: {
				onDelivery(params) {
					sends.push(params.deliveryId.length);
					return { status: "delivered", external: { id: params.deliveryId } };
				},
			},
		});
		await connector.start();
		return { connector, sends };
	};

	try {
		await act({ mason, path, open });
	} finally {
		mason.stop();
		await rm(dir, { recursive: true, force: true });
	}
}

const origin = { connector: "chat", externalConversationId: "-1001234" };

test("a call journaled before a restart is replayed once by the next process", async () => {
	await withFixture(async ({ mason, open }) => {
		const first = await open();
		mason.kill("the process is going away");
		const outcome = await first.connector.submit({
			origin,
			actor: { externalActorId: "u-8811" },
			content: [{ type: "text", text: "while you were out" }],
			submissionId: "restart-1",
		});
		assert.equal(outcome.status, "pending");
		await first.connector.stop();
		assert.equal(mason.submissions.length, 0);

		const second = await open();
		try {
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(mason.submissions.length, 1, "the journaled call was replayed by the new process");
			assert.equal(mason.submissions[0]?.submissionId, "restart-1");
		} finally {
			await second.connector.stop();
		}
	});
});

test("a delivery settled before a restart is a duplicate after it, and nobody is sent it twice", async () => {
	await withFixture(async ({ mason, open }) => {
		const first = await open();
		const ack = await mason.deliver({
			deliveryId: "restart-delivery",
			origin,
			blocks: [{ type: "text", text: "hello" }],
		});
		assert.equal(ack?.status, "delivered");
		assert.equal(first.sends.length, 1);
		await first.connector.stop();

		const second = await open();
		try {
			const again = await mason.deliver({
				deliveryId: "restart-delivery",
				origin,
				blocks: [{ type: "text", text: "hello" }],
			});
			assert.equal(again?.status, "duplicate");
			assert.equal(second.sends.length, 0, "the new process remembered the id it never saw");
		} finally {
			await second.connector.stop();
		}
	});
});
