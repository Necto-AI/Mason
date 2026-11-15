/**
 * Attachments: bytes cross as a content id, over an endpoint the connector authenticates with its own credential.
 *
 * The refusals the protocol names are pinned here — no credential, a body over the cap, and a byte-fetch the endpoint
 * does not answer because there is no such route.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { ATTACHMENT_BYTES } from "../src/server/attachments.ts";
import { CONNECTOR_ENTRY_KIND } from "../src/shared/contract.ts";
import { connectConnector, entriesOf, serveConnector, until } from "./support/connector.ts";

const BYTES = new TextEncoder().encode("a photograph, allegedly");

describe("the attachment endpoint", () => {
	it("stores an upload under an id, with its name and type", async () => {
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
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("refuses a body over the cap, and answers no byte-fetch on the upload path", async () => {
		const served = await serveConnector({ attachmentBytes: 32 });
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(BYTES, { mimeType: "image/jpeg" });

				// Over the cap: `413`, and nothing stored.
				const tooBig = await fetch(`${served.base}/api/connector/attachments`, {
					method: "POST",
					headers: { authorization: `Bearer ${served.credential}`, "content-type": "text/plain" },
					body: new Uint8Array(33),
				});
				assert.equal(tooBig.status, 413);

				// There is no read-back route: a credentialed GET under the upload path is the same `404` as a path mason does
				// not serve, which is what keeps a content id from being fetched by a holder of the credential alone.
				const readBack = await fetch(`${served.base}/api/connector/attachments/${upload.contentId}`, {
					headers: { authorization: `Bearer ${served.credential}` },
				});
				assert.equal(readBack.status, 404);
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
			steps: [fauxAssistantMessage(fauxText("nice photo"))],
		});
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(BYTES, {
					mimeType: "image/png",
					name: "shot.png",
				});
				const outcome = await connected.connector.submit({
					origin: { ref: "team", actor: { id: "8811" } },
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
				assert.match(content[0]?.text ?? "", /^what is this\n/);
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
					origin: { ref: "team", actor: { id: "8811" } },
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
