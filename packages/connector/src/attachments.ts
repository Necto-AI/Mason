/**
 * Attachments, as content ids and authenticated HTTP.
 *
 * Bytes never cross the JSON-RPC socket and never sit in an argument as base64: a shared filesystem path is not a remote
 * protocol, and a 40 MB message is not a JSON-RPC frame. Mason hands back an id, the connector references that id, and
 * the bytes go up over that connector's own credentialed endpoint.
 *
 * The mechanics a connector would otherwise reimplement badly live here: the headers, the size cap, the expiry, and the
 * fact that an error is a coded refusal rather than a mystery status.
 */
import type { AttachmentUploadResult, ProtocolErrorData } from "mason-protocol";

export interface AttachmentClient {
	/** Put bytes in mason's store and get the id to reference. */
	upload(
		bytes: Uint8Array,
		meta?: { readonly mimeType?: string; readonly name?: string },
	): Promise<AttachmentUploadResult>;
}

/** A refusal from the transfer endpoint, with the status and mason's code when it sent one. */
export class AttachmentError extends Error {
	readonly status: number;
	readonly data: ProtocolErrorData | undefined;

	constructor(status: number, message: string, data?: ProtocolErrorData) {
		super(message);
		this.name = "AttachmentError";
		this.status = status;
		this.data = data;
	}
}

/** The platform `fetch`, in the one shape this file uses, so a test can substitute it. */
export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface AttachmentClientOptions {
	readonly baseUrl: string;
	readonly credential: string;
	readonly fetch?: Fetcher;
	/**
	 * The SDK's own guard, checked before a byte is sent. Mason enforces its own cap regardless, and the number is only
	 * known after the handshake, so this is read at the moment of the call.
	 */
	readonly maxBytes?: number | (() => number | undefined);
}

export function createAttachmentClient(options: AttachmentClientOptions): AttachmentClient {
	const doFetch: Fetcher = options.fetch ?? ((input, init) => fetch(input, init));
	const base = options.baseUrl.replace(/\/$/, "");

	return {
		async upload(bytes, meta = {}) {
			const cap = typeof options.maxBytes === "function" ? options.maxBytes() : options.maxBytes;
			if (cap !== undefined && bytes.byteLength > cap) {
				throw new AttachmentError(413, `that file is ${bytes.byteLength} bytes and this connector may send ${cap}`);
			}
			const headers: Record<string, string> = {
				authorization: `Bearer ${options.credential}`,
				// The file's own type, in the header that carries it: a `x-mason-mime` beside it would be a second way to
				// say one thing, and a mason built from the document would read neither.
				"content-type": meta.mimeType ?? "application/octet-stream",
			};
			if (meta.name !== undefined) headers["x-mason-filename"] = encodeURIComponent(meta.name);
			const response = await doFetch(`${base}/api/connector/attachments`, {
				method: "POST",
				headers,
				body: bytes as unknown as BodyInit,
			});
			if (!response.ok) throw await refusal(response);
			return (await response.json()) as AttachmentUploadResult;
		},
	};
}

async function refusal(response: Response): Promise<AttachmentError> {
	let data: ProtocolErrorData | undefined;
	let message = `the transfer endpoint answered ${response.status}`;
	try {
		const body = (await response.json()) as Record<string, unknown>;
		if (typeof body.message === "string") message = body.message;
		if (typeof body.code === "string" && typeof body.message === "string") {
			data = body as unknown as ProtocolErrorData;
		}
	} catch {
		// A body that is not JSON is a refusal with the status and nothing else, which is still a refusal.
	}
	return new AttachmentError(response.status, message, data);
}
