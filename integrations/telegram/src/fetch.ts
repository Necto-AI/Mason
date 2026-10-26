/**
 * How this container reaches the network, and the one reason it needs a proxy to do it.
 *
 * Telegram is blocked where this runs, so the deployment puts a `vpn` sidecar on `mason-edge` and hands this container
 * `HTTPS_PROXY=http://vpn:1080`. Node's own `fetch` does not read that variable on Node 22 (it became an option in 24 via
 * `NODE_USE_ENV_PROXY`), and it has no way to take a proxy without a dispatcher, so this file builds one: `undici`'s
 * `ProxyAgent`, which is the same client `fetch` is made of, configured with the proxy's address. Saying so is the point
 * — a reader who expects `HTTPS_PROXY` to work by itself deserves to know why it does not here.
 *
 * **The proxy is for Telegram, not for mason.** The door is `http://mason:8787/api/events/telegram` on the compose
 * network, and the sidecar has no route to a name that only exists inside it. So there are two fetches: the API's, which
 * may be proxied, and the door's, which is always direct. One variable, one route — and the event path never depends on
 * the VPN being up, which is what keeps a VPN outage from looking like a delivery made.
 */
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { Log } from "./log.ts";
import type { Fetch, FetchRequest } from "./telegram.ts";

/** The platform's own fetch, wrapped to the signature this package uses so both routes look the same to a caller. */
export function directFetch(): Fetch {
	return (url, request) => fetch(url, initFor(request));
}

/**
 * A fetch that goes through `proxyUrl`. The agent is returned with the function because it owns a connection pool that
 * has to be closed, and a pool nobody closes keeps the process alive after the last poll.
 */
export function proxiedFetch(proxyUrl: string, log: Log): { readonly fetch: Fetch; close(): Promise<void> } {
	const agent = new ProxyAgent(proxyUrl);
	log("info", `Telegram API calls go through the proxy at ${proxyUrl}`);
	return {
		fetch: async (url, request) => undiciFetch(url, { ...initFor(request), dispatcher: agent }),
		close: () => agent.close(),
	};
}

/**
 * The parts of a request both clients understand, built as a plain object rather than as either one's `RequestInit`.
 * Declaring one of the two types would make the object unusable by the other: Node's `fetch` and `undici`'s are the same
 * shape and two different type trees.
 */
function initFor(request: FetchRequest): {
	readonly method: "GET" | "POST";
	readonly headers: Record<string, string>;
	readonly body?: string;
	readonly signal?: AbortSignal;
} {
	return {
		method: request.method,
		headers: request.headers,
		...(request.body === undefined ? {} : { body: request.body }),
		...(request.signal === undefined ? {} : { signal: request.signal }),
	};
}
