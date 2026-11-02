/**
 * The socket, as the SDK needs it and no more: send a string, receive a string, learn when it died.
 *
 * It is an interface rather than a `WebSocket` because the conformance suite has to drive a connector without binding a
 * port, and because a connector in an environment with its own socket implementation should not have to fork the SDK.
 * The default factory wraps the platform's `WebSocket`.
 */

export interface Link {
	readonly kind: string;
	send(text: string): void;
	close(reason?: string): void;
	onMessage(listener: (text: string) => void): void;
	onClose(listener: (reason: string) => void): void;
	onOpen(listener: () => void): void;
}

export type LinkFactory = (url: string, init: { readonly credential: string }) => Link;

/** The socket API this module needs, which every `WebSocket` implementation has and a test's pair imitates. */
export interface WebSocketLike {
	addEventListener(type: string, listener: (event: never) => void): void;
	send(text: string): void;
	close(code?: number, reason?: string): void;
	readyState: number;
}

/** How a `WebSocket` is constructed: `ws` takes the credential headers, the browser one does not. */
export type WebSocketConstructor = new (url: string, options?: unknown) => WebSocketLike;

/**
 * A link over one socket, with the credential in the upgrade request's `Authorization` header.
 *
 * The header is why the constructor is a parameter. A browser's `WebSocket` cannot set one — the protocol has no API for
 * it — and Node's built-in one (undici) cannot either, while `ws` can. The protocol requires the header, so a connector
 * running on Node uses `nodeWebSocketLink(WebSocket)` with `ws` installed; `webSocketLink` is for a runtime whose
 * constructor accepts `{headers}` (a browser bundle talking through a proxy that injects it, or a future Node).
 *
 * Getting this wrong is silent in the worst way: a constructor that ignores the options object opens an unauthenticated
 * socket and mason closes it, which reads like a credential problem rather than a transport one.
 */
export function linkOver(socket: WebSocketLike): Link {
	const messageListeners: Array<(text: string) => void> = [];
	const closeListeners: Array<(reason: string) => void> = [];
	const openListeners: Array<() => void> = [];
	let opened = false;
	const flushed: string[] = [];

	const emit = (text: string) => {
		for (const listener of messageListeners) listener(text);
	};

	socket.addEventListener("open", () => {
		opened = true;
		for (const listener of openListeners) listener();
		for (const text of flushed.splice(0)) socket.send(text);
	});
	socket.addEventListener("message", (event: { data: unknown }) => {
		const data = event.data;
		if (typeof data === "string") {
			emit(data);
			return;
		}
		void (data as Blob).text().then(emit);
	});
	socket.addEventListener("close", (event: { reason?: string }) => {
		for (const listener of closeListeners) listener(event.reason || "socket closed");
	});
	socket.addEventListener("error", () => {
		for (const listener of closeListeners) listener("socket error");
	});

	return {
		kind: "websocket",
		send(text) {
			if (opened && socket.readyState === 1) socket.send(text);
			else flushed.push(text);
		},
		close(reason) {
			socket.close(1000, reason ?? "closed");
		},
		onMessage(listener) {
			messageListeners.push(listener);
		},
		onClose(listener) {
			closeListeners.push(listener);
		},
		onOpen(listener) {
			openListeners.push(listener);
		},
	};
}

/** A link over the platform `WebSocket`, passing the credential as a header it must be able to carry. */
export function webSocketLink(url: string, init: { readonly credential: string }): Link {
	const socket = new WebSocket(url, { headers: { authorization: `Bearer ${init.credential}` } } as never);
	return linkOver(socket as unknown as WebSocketLike);
}

/**
 * A link over a Node `WebSocket` implementation that accepts upgrade options — `ws`, in practice.
 *
 * ```ts
 * import WebSocket from "ws";
 * const connector = createConnector({ ..., link: nodeWebSocketLink(WebSocket) });
 * ```
 */
export function nodeWebSocketLink(WebSocketImpl: WebSocketConstructor): LinkFactory {
	return (url, init) => linkOver(new WebSocketImpl(url, { headers: { authorization: `Bearer ${init.credential}` } }));
}

interface End {
	readonly messages: Array<(text: string) => void>;
	readonly closes: Array<(reason: string) => void>;
	readonly opens: Array<() => void>;
	closed: boolean;
}

/**
 * Two ends of one in-memory link, for tests. Delivery is synchronous, which is what a test wants: an assertion right
 * after a call sees the effect of that call. Closing one end closes the other, exactly as a real socket's peer learns
 * that the connection is gone.
 */
export function linkPair(): [Link, Link] {
	const a: End = { messages: [], closes: [], opens: [], closed: false };
	const b: End = { messages: [], closes: [], opens: [], closed: false };
	const link = (self: End, peer: End, kind: string): Link => ({
		kind,
		send(text) {
			if (self.closed || peer.closed) return;
			for (const listener of peer.messages) listener(text);
		},
		close(reason) {
			if (self.closed) return;
			self.closed = true;
			const why = reason ?? "closed";
			for (const listener of self.closes) listener(why);
			if (peer.closed) return;
			peer.closed = true;
			for (const listener of peer.closes) listener(why);
		},
		onMessage(listener) {
			self.messages.push(listener);
		},
		onClose(listener) {
			self.closes.push(listener);
		},
		onOpen(listener) {
			self.opens.push(listener);
			listener();
		},
	});

	return [link(a, b, "pair-a"), link(b, a, "pair-b")];
}
