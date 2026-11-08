/**
 * The one transport a Node connector needs, and nothing else: Chord owns the link protocol, so all that is left here is
 * the credential's header.
 *
 * A `WebSocket` protocol has no API for a request header. Node's built-in one cannot set one, and `ws` can, which is why
 * the constructor is a parameter instead of an import: a connector that runs where a proxy injects the header passes
 * Chord's `webSocketLink` itself and never loads this module.
 *
 * Getting this wrong is silent in the worst way: a constructor that ignores the options object opens an unauthenticated
 * socket and mason closes it, which reads like a credential problem rather than a transport one.
 */
import { type Link, type WebSocketLike, webSocketLink } from "@earendil-works/chord";
import type { LinkFactory } from "./connector.ts";

/** How a `WebSocket` is constructed: `ws` takes the credential headers, a browser's does not. */
export type WebSocketConstructor = new (url: string, options?: unknown) => WebSocketLike;

/**
 * A link over a Node `WebSocket` implementation that accepts upgrade options — `ws`, in practice.
 *
 * ```ts
 * import WebSocket from "ws";
 * const connector = createConnector({ ..., link: nodeWebSocketLink(WebSocket) });
 * ```
 */
export function nodeWebSocketLink(WebSocketImpl: WebSocketConstructor): LinkFactory {
	return (url, init): Link =>
		webSocketLink(new WebSocketImpl(url, { headers: { authorization: `Bearer ${init.credential}` } }));
}
