/**
 * The browser's Chord link to the server: one host in client mode, one `AgentService` reference, and a
 * reconnect loop that keeps the reference (and every subscription on it) alive across socket drops.
 */
import { createHost, type Ref, webSocketLink, type WebSocketLike } from "@earendil-works/chord";
import { AgentService } from "../shared/contract.ts";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface AgentConnection {
	readonly agent: Ref<typeof AgentService>;
	state(): ConnectionState;
	subscribe(listener: (state: ConnectionState) => void): () => void;
	close(): void;
}

export interface ConnectOptions {
	/** WebSocket URL, e.g. `ws://127.0.0.1:8787/`. */
	readonly url: string;
	readonly onError?: (error: unknown) => void;
	/** Reconnect backoff bounds in milliseconds. */
	readonly minDelayMs?: number;
	readonly maxDelayMs?: number;
}

export function connectAgent(options: ConnectOptions): AgentConnection {
	const listeners = new Set<(state: ConnectionState) => void>();
	let state: ConnectionState = "connecting";
	let socket: WebSocket | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let delay = options.minDelayMs ?? 500;
	let closed = false;

	const setState = (next: ConnectionState): void => {
		if (state === next) return;
		state = next;
		for (const listener of listeners) listener(next);
	};

	const host = createHost({
		self: { kind: "server" },
		name: "browser",
		kind: "client",
		onError: (error) => {
			options.onError?.(error);
			// A dropped link reports itself through the reference status; the socket's close handler reconnects.
		},
	});

	const open = (): void => {
		if (closed) return;
		setState("connecting");
		const next = new WebSocket(options.url);
		socket = next;
		next.addEventListener("open", () => {
			delay = options.minDelayMs ?? 500;
			setState("connected");
		});
		next.addEventListener("close", () => {
			if (closed) return;
			if (socket === next) socket = undefined;
			setState("disconnected");
			retry = setTimeout(open, delay);
			delay = Math.min(delay * 2, options.maxDelayMs ?? 5_000);
		});
		next.addEventListener("error", (error) => options.onError?.(error));
		host.connect(webSocketLink(next as unknown as WebSocketLike), {
			principal: { kind: "server" },
			// The server's protocol version changed under us: the only fix is a fresh bundle.
			onProtocolMismatch: () => location.reload(),
		});
	};

	open();
	// Order matters: a reference created while the host has no upstream never binds. The first `connect` must
	// happen first; later connects re-hold the existing reference. A hold rather than an awaited get: the shell renders
	// the reference's status while it is still loading.
	const agent = host.hold(AgentService, {});

	return {
		agent,
		state: () => state,
		subscribe(listener) {
			listeners.add(listener);
			listener(state);
			return () => listeners.delete(listener);
		},
		close() {
			closed = true;
			if (retry !== undefined) clearTimeout(retry);
			socket?.close();
			void host.close();
		},
	};
}