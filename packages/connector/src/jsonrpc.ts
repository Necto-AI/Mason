/**
 * JSON-RPC 2.0, the three shapes it has and nothing else.
 *
 * Both sides of the connector socket are clients and servers at once, so a frame is only ever one of these. Keeping the
 * union small is what makes the transport able to say what it received rather than guessing at a half-typed object.
 */
import { type ProtocolErrorData, RPC_ERROR } from "@mason/protocol";

export type RpcId = string | number;

export interface RpcRequest {
	readonly jsonrpc: "2.0";
	readonly id: RpcId;
	readonly method: string;
	readonly params?: unknown;
}

export interface RpcNotification {
	readonly jsonrpc: "2.0";
	readonly method: string;
	readonly params?: unknown;
}

export interface RpcSuccess {
	readonly jsonrpc: "2.0";
	readonly id: RpcId;
	readonly result: unknown;
}

export interface RpcFailure {
	readonly jsonrpc: "2.0";
	readonly id: RpcId | null;
	readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export type RpcMessage = RpcRequest | RpcNotification | RpcSuccess | RpcFailure;

export function isRequest(message: RpcMessage): message is RpcRequest {
	return "method" in message && "id" in message;
}

export function isNotification(message: RpcMessage): message is RpcNotification {
	return "method" in message && !("id" in message);
}

export function isFailure(message: RpcMessage): message is RpcFailure {
	return "error" in message;
}

export function isSuccess(message: RpcMessage): message is RpcSuccess {
	return "result" in message;
}

/** Parse one text frame into exactly one message, or refuse it with the code to answer with. */
export function parseFrame(text: string): { ok: true; message: RpcMessage } | { ok: false; code: number } {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { ok: false, code: RPC_ERROR.parse };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, code: RPC_ERROR.invalidRequest };
	}
	const record = value as Record<string, unknown>;
	if (record.jsonrpc !== "2.0") return { ok: false, code: RPC_ERROR.invalidRequest };
	if (typeof record.method === "string") {
		if (record.id !== undefined && typeof record.id !== "string" && typeof record.id !== "number") {
			return { ok: false, code: RPC_ERROR.invalidRequest };
		}
		return { ok: true, message: value as RpcMessage };
	}
	if (record.error !== undefined) {
		if (typeof record.error !== "object" || record.error === null)
			return { ok: false, code: RPC_ERROR.invalidRequest };
		return { ok: true, message: value as RpcFailure };
	}
	if (record.result !== undefined) {
		if (typeof record.id !== "string" && typeof record.id !== "number") {
			return { ok: false, code: RPC_ERROR.invalidRequest };
		}
		return { ok: true, message: value as RpcSuccess };
	}
	return { ok: false, code: RPC_ERROR.invalidRequest };
}

export function request(id: RpcId, method: string, params?: unknown): RpcRequest {
	return params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
}

export function notification(method: string, params?: unknown): RpcNotification {
	return params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
}

export function success(id: RpcId, result: unknown): RpcSuccess {
	return { jsonrpc: "2.0", id, result };
}

export function failure(id: RpcId | null, code: number, message: string, data?: unknown): RpcFailure {
	const error = data === undefined ? { code, message } : { code, message, data };
	return { jsonrpc: "2.0", id, error };
}

/**
 * The error a peer sees when mason refuses a call. `-32000` is the implementation-defined range JSON-RPC leaves for
 * exactly this: a request that parsed, was understood, and was declined for a reason the protocol names in `data`.
 */
export const MASON_ERROR_RPC_CODE = -32000;

export function protocolFailure(id: RpcId | null, data: ProtocolErrorData): RpcFailure {
	return failure(id, MASON_ERROR_RPC_CODE, data.message, data);
}

/** The `data` of a failure when it is one of ours, so a caller can branch on the code rather than on a sentence. */
export function protocolErrorOf(error: { readonly data?: unknown }): ProtocolErrorData | undefined {
	const data = error.data;
	if (typeof data !== "object" || data === null) return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.code !== "string" || typeof record.message !== "string") return undefined;
	return record as unknown as ProtocolErrorData;
}
