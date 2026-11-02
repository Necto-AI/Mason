/**
 * The panel's only door: `GET /api/admin/state` and the writes under `/api/admin/`.
 *
 * The server decides what a device may see, so this file asks once and believes the answer: an area missing from the
 * state is an area this device has no grant for, and the shell draws what it was given rather than asking again for
 * what it was refused. A refusal on a write is the one thing the page has to say out loud.
 */
import type { PanelState } from "../../shared/admin.ts";

/** An answer that is not `2xx`, with the sentence the server answered. */
export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function answer<T>(response: Response): Promise<T> {
	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = text === "" ? {} : JSON.parse(text);
	} catch {
		throw new ApiError(response.status, `the server answered ${response.status} without JSON`);
	}
	if (!response.ok) {
		const message = (parsed as { error?: unknown }).error;
		throw new ApiError(
			response.status,
			typeof message === "string" ? message : `the server answered ${response.status}`,
		);
	}
	return parsed as T;
}

export async function readState(signal?: AbortSignal): Promise<PanelState> {
	const response = await fetch("/api/admin/state", {
		credentials: "same-origin",
		headers: { accept: "application/json" },
		...(signal === undefined ? {} : { signal }),
	});
	return answer<PanelState>(response);
}

/** One write. `body` is JSON; a route with nothing to say sends none. */
export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(path, {
		method,
		credentials: "same-origin",
		headers: {
			accept: "application/json",
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return answer<T>(response);
}
