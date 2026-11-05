/**
 * One socket, both directions, with the bookkeeping JSON-RPC makes you do.
 *
 * The peer knows three things the connector should not have to: which ids are outstanding, how to answer a request it
 * was handed, and that a socket which died leaves its calls unanswered rather than failed. The last one matters most:
 * a call that died with the socket is *unknown*, not refused, and the caller decides whether to resend it. This file
 * never retries anything on its own.
 */

import { ERROR_CODE, type ProtocolErrorData, RPC_ERROR } from "mason-protocol";
import {
	failure,
	isFailure,
	isNotification,
	isRequest,
	isSuccess,
	notification,
	parseFrame,
	protocolErrorOf,
	type RpcId,
	type RpcMessage,
	request,
	success,
} from "./jsonrpc.ts";
import type { Link } from "./link.ts";

/** What a peer does with what it receives. */
export interface PeerHandlers {
	/** An inbound request. A throw becomes a JSON-RPC error; a `ProtocolErrorData` becomes a coded one. */
	request(method: string, params: unknown): Promise<unknown>;
	/** An inbound notification, which is answered by nothing. */
	notification(method: string, params: unknown): void;
	/** The socket is gone. Called once per link. */
	closed(reason: string): void;
}

/** The call did not finish before its timeout. It is still outstanding as far as the wire is concerned. */
export class PeerTimeout extends Error {
	readonly method: string;
	readonly timeoutMs: number;

	constructor(method: string, timeoutMs: number) {
		super(`${method} did not answer within ${timeoutMs} ms`);
		this.name = "PeerTimeout";
		this.method = method;
		this.timeoutMs = timeoutMs;
	}
}

/** The peer refused the call and said why in the protocol's own vocabulary. */
export class PeerError extends Error {
	readonly method: string;
	readonly rpcCode: number;
	readonly data: ProtocolErrorData | undefined;

	constructor(method: string, rpcCode: number, message: string, data: ProtocolErrorData | undefined) {
		super(message);
		this.name = "PeerError";
		this.method = method;
		this.rpcCode = rpcCode;
		this.data = data;
	}

	get retryable(): boolean {
		return this.data?.retryable === true;
	}

	get retryAfterMs(): number | undefined {
		return this.data?.retryAfterMs;
	}
}

interface Outstanding {
	readonly method: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout> | undefined;
}

export class RpcPeer {
	private readonly link: Link;
	private readonly handlers: PeerHandlers;
	private readonly timeoutMs: number;
	private readonly outstanding = new Map<RpcId, Outstanding>();
	private nextId = 0;
	private closedReason: string | undefined;
	private linkClosed = false;

	constructor(link: Link, handlers: PeerHandlers, options: { readonly timeoutMs?: number } = {}) {
		this.link = link;
		this.handlers = handlers;
		this.timeoutMs = options.timeoutMs ?? 30_000;
		link.onMessage((text) => this.receive(text));
		link.onClose((reason) => this.onLinkClosed(reason));
	}

	get open(): boolean {
		return this.closedReason === undefined;
	}

	get outstandingCount(): number {
		return this.outstanding.size;
	}

	/** Send a call and wait for its answer. Rejects with `PeerTimeout`, `PeerError`, or the reason the socket died. */
	async call(method: string, params?: unknown, options: { readonly timeoutMs?: number } = {}): Promise<unknown> {
		if (this.closedReason !== undefined) throw new Error(`the socket is closed: ${this.closedReason}`);
		const id = `c${++this.nextId}`;
		const timeoutMs = options.timeoutMs ?? this.timeoutMs;
		const answer = new Promise<unknown>((resolve, reject) => {
			const timer =
				timeoutMs <= 0
					? undefined
					: setTimeout(() => {
							this.outstanding.delete(id);
							reject(new PeerTimeout(method, timeoutMs));
						}, timeoutMs);
			this.outstanding.set(id, { method, resolve, reject, timer });
		});
		this.link.send(JSON.stringify(request(id, method, params)));
		return answer;
	}

	/** Send a notification. Nothing will answer it, and nothing here waits. */
	notify(method: string, params?: unknown): void {
		if (this.closedReason !== undefined) return;
		this.link.send(JSON.stringify(notification(method, params)));
	}

	/**
	 * Send a call and deliberately do not wait for its answer.
	 *
	 * This is how a lost acknowledgement is simulated, and it is the only honest way to write that test: the answer may
	 * exist and be dropped on the way back, and the caller has to treat the call as unknown rather than as failed. The
	 * response, if it arrives, is ignored by `settle` because nothing is outstanding under that id.
	 */
	sendWithoutWaiting(method: string, params?: unknown): RpcId {
		const id = `n${++this.nextId}`;
		if (this.closedReason !== undefined) return id;
		this.link.send(JSON.stringify(request(id, method, params)));
		return id;
	}

	/**
	 * Stop using this socket. Every outstanding call is rejected as unknown, because a call the other end may have
	 * acted on is not a call that failed.
	 */
	close(reason = "closed by the connector"): void {
		this.onLinkClosed(reason);
		this.link.close(reason);
	}

	private onLinkClosed(reason: string): void {
		if (this.linkClosed) return;
		this.linkClosed = true;
		this.closedReason = reason;
		const pending = [...this.outstanding.values()];
		this.outstanding.clear();
		for (const entry of pending) {
			if (entry.timer !== undefined) clearTimeout(entry.timer);
			entry.reject(new Error(`${entry.method} was in flight when the socket closed: ${reason}`));
		}
		this.handlers.closed(reason);
	}

	private receive(text: string): void {
		const parsed = parseFrame(text);
		if (!parsed.ok) {
			this.link.send(JSON.stringify(failure(null, parsed.code, "that frame is not JSON-RPC 2.0")));
			return;
		}
		const message: RpcMessage = parsed.message;
		if (isRequest(message)) {
			void this.answer(message.id, message.method, message.params);
			return;
		}
		if (isNotification(message)) {
			// Nobody is waiting for a notification, so a rejection has nowhere to go but the process. A handler that
			// throws is a medium that cannot render one thing, not a reason to kill an always-on connector.
			void Promise.resolve(this.handlers.notification(message.method, message.params)).catch((error: unknown) => {
				this.handlers.notification("connector/handler_error", {
					method: message.method,
					detail: error instanceof Error ? error.message : String(error),
				});
			});
			return;
		}
		if (isSuccess(message)) {
			this.settle(message.id, (entry) => entry.resolve(message.result));
			return;
		}
		if (isFailure(message)) {
			if (message.id === null) {
				this.handlers.notification("connector/error", message.error);
				return;
			}
			const failureMessage = message.error.message;
			const failureCode = message.error.code;
			const failureData = protocolErrorOf(message.error);
			this.settle(message.id, (entry) =>
				entry.reject(new PeerError(entry.method, failureCode, failureMessage, failureData)),
			);
		}
	}

	private settle(id: RpcId, act: (entry: Outstanding) => void): void {
		const entry = this.outstanding.get(id);
		if (entry === undefined) return;
		this.outstanding.delete(id);
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		act(entry);
	}

	private async answer(id: RpcId, method: string, params: unknown): Promise<void> {
		try {
			const result = await this.handlers.request(method, params);
			this.link.send(JSON.stringify(success(id, result ?? {})));
		} catch (error) {
			if (error instanceof PeerError && error.data !== undefined) {
				this.link.send(JSON.stringify(failure(id, error.rpcCode, error.message, error.data)));
				return;
			}
			const data: ProtocolErrorData = {
				code: ERROR_CODE.internal,
				message: error instanceof Error ? error.message : String(error),
			};
			this.link.send(JSON.stringify(failure(id, RPC_ERROR.internal, data.message, data)));
		}
	}
}

/** The data of a refusal this peer raised on the wire, so a caller can construct one with a code and a sentence. */
export function codedFailure(code: ProtocolErrorData["code"], message: string, extra: Partial<ProtocolErrorData> = {}) {
	return new PeerError("<local>", -32000, message, { code, message, ...extra });
}
