/**
 * Attachments: bytes cross as a content id, over an endpoint the connector authenticates with its own credential.
 *
 * Every refusal the protocol names is pinned here — no credential, a foreign id, an id past its expiry, a body over the
 * cap — because the value of the endpoint is entirely in the four answers being different from one another.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ATTACHMENT_BYTES } from "../src/server/attachments.ts";
import { mintConnectorCredential } from "../src/server/connectors.ts";
import { CONNECTOR_ENTRY_KIND, REPLY_TOOL } from "../src/shared/contract.ts";
import { connectConnector, entriesOf, serveConnector, until } from "./support/connector.ts";

const BYTES = new TextEncoder().encode("a photograph, allegedly");

describe("the attachment endpoint", () => {
	it("stores an upload under an id and serves the same bytes back, with its name and type", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(BYTES, {
					mimeType: "image/jpeg",
					name: "holiday photo.jpg",
				});
				assert.match(upload.contentId, /^cnt_[0-9a-f]{32}$/);
				assert.equal(upload.size, BYTES.byteLength);
				assert.ok((upload.expiresAt ?? 0) > Date.now());
				const download = await connected.connector.attachments.download(upload.contentId);
				assert.deepEqual([...download.bytes], [...BYTES]);
				assert.equal(download.mimeType, "image/jpeg");
				assert.equal(download.name, "holiday photo.jpg");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("refuses no credential, a foreign id, an expired id and an oversized body — with four different answers", async () => {
		const served = await serveConnector({ attachmentBytes: 32, attachmentTtlMs: 150 });
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(BYTES, { mimeType: "image/jpeg" });

				const anonymous = await fetch(`${served.base}/api/connector/attachments/${upload.contentId}`);
				assert.equal(anonymous.status, 401);

				// Another connector's id is a `404`: which ids exist is not a sender's business.
				const other = await mintConnectorCredential(served.paths.home, "alarm-only");
				const foreign = await fetch(`${served.base}/api/connector/attachments/${upload.contentId}`, {
					headers: { authorization: `Bearer ${other.credential}` },
				});
				assert.equal(foreign.status, 404);

				// Over the cap: `413`, and nothing stored.
				const tooBig = await fetch(`${served.base}/api/connector/attachments`, {
					method: "POST",
					headers: { authorization: `Bearer ${served.credential}`, "content-type": "text/plain" },
					body: new Uint8Array(33),
				});
				assert.equal(tooBig.status, 413);

				// Expiry: `410`, and only after the ttl the handshake advertised has passed.
				await new Promise((resolve) => setTimeout(resolve, 200));
				const expired = await fetch(`${served.base}/api/connector/attachments/${upload.contentId}`, {
					headers: { authorization: `Bearer ${served.credential}` },
				});
				assert.equal(expired.status, 410);

				// A malformed id is the same `404` a foreign one gets — including an id that is not decodable at all, which
				// used to throw out of the handler and answer a `500` with a stack in the log.
				for (const id of ["not-an-id", "%zz"]) {
					const malformed = await fetch(`${served.base}/api/connector/attachments/${id}`, {
						headers: { authorization: `Bearer ${served.credential}` },
					});
					assert.equal(malformed.status, 404, id);
				}
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("advertises the cap and the ttl it enforces, so a connector can refuse before it sends", async () => {
		const served = await serveConnector({ attachmentBytes: 1024, attachmentTtlMs: 60_000 });
		try {
			const connected = await connectConnector(served);
			try {
				const limits = connected.connector.status().session?.limits;
				assert.equal(limits?.attachmentBytes, 1024);
				assert.equal(limits?.attachmentTtlMs, 60_000);
				// The SDK's own guard reads the negotiated number, so a file over it never reaches the wire.
				await assert.rejects(
					connected.connector.attachments.upload(new Uint8Array(1025)),
					(error: { status?: number }) => error.status === 413,
				);
				assert.equal(
					ATTACHMENT_BYTES,
					25 * 1024 * 1024,
					"the default cap is the protocol's, and the fixture only narrows it for the test",
				);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("a submission with a file", () => {
	it("reaches the model as an image block and as a path a tool can open", async () => {
		const served = await serveConnector({
			steps: [
				fauxAssistantMessage([fauxToolCall(REPLY_TOOL, { message: "nice photo" })], { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxText("done")),
			],
		});
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(BYTES, {
					mimeType: "image/png",
					name: "shot.png",
				});
				const outcome = await connected.connector.submit({
					origin: { connector: "telegram", externalConversationId: "-1001234" },
					actor: { externalActorId: "8811" },
					content: [
						{ type: "text", text: "what is this" },
						{ type: "file", contentId: upload.contentId, name: "shot.png" },
					],
				});
				assert.equal(outcome.status, "accepted");
				await until(
					async () => (await entriesOf(served.server)).some((entry) => entry.kind === CONNECTOR_ENTRY_KIND),
					"the entry",
				);
				const entry = (await entriesOf(served.server)).find((candidate) => candidate.kind === CONNECTOR_ENTRY_KIND);
				const content = (entry?.model as Array<{ content: unknown }>)[0]?.content as Array<{
					type: string;
					text?: string;
					mimeType?: string;
					data?: string;
				}>;
				assert.equal(content[0]?.type, "text");
				assert.match(content[0]?.text ?? "", /\[from Denis\] what is this/);
				const image = content.find((block) => block.type === "image");
				assert.equal(image?.mimeType, "image/png");
				assert.equal(Buffer.from(image?.data ?? "", "base64").toString("utf8"), "a photograph, allegedly");
				// The same bytes are on disk in the workspace, so `read` can open them from the tool machine.
				assert.match(content[0]?.text ?? "", /inbox\/cnt_[0-9a-f]{32}-shot\.png/);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("names a missing upload instead of pretending the file arrived", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const outcome = await connected.connector.submit({
					origin: { connector: "telegram", externalConversationId: "-1001234" },
					actor: { externalActorId: "8811" },
					content: [{ type: "file", contentId: "cnt_00000000000000000000000000000000" }],
				});
				assert.equal(outcome.status, "accepted");
				await until(
					async () => (await entriesOf(served.server)).some((entry) => entry.kind === CONNECTOR_ENTRY_KIND),
					"the entry",
				);
				const entry = (await entriesOf(served.server)).find((candidate) => candidate.kind === CONNECTOR_ENTRY_KIND);
				const content = (entry?.model as Array<{ content: unknown }>)[0]?.content as Array<{ text?: string }>;
				assert.match(JSON.stringify(content), /no such upload/);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});
