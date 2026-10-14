/**
 * The client shell: connect to the server's Chord host, keep a subscription on the conversation state, and render
 * the session bar, the transcript (with its queue and jump pill) and the composer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentStatus } from "../shared/contract.ts";
import { connectAgent, type AgentConnection } from "./client.ts";
import { Composer } from "./components/Composer.tsx";
import { JumpPill } from "./components/JumpPill.tsx";
import { SessionBar } from "./components/SessionBar.tsx";
import { Transcript } from "./components/Transcript.tsx";
import { useFollower } from "./lib/follower.ts";
import type { WidgetBridge } from "./lib/websandbox-loader.ts";
import { inbox as inboxOf, live as liveOf, toolCallsOf, type ConversationViewLike } from "./view-types.ts";
import "./styles/tokens.css";
import "./styles/chat.css";

const DEBUG_KEY = "pda-debug";

function webSocketUrl(): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${window.location.host}/`;
}

function debugFromUrl(): boolean {
	return new URLSearchParams(window.location.search).has("debug");
}

function useAgent(): {
	connection: AgentConnection;
	connectionState: "connecting" | "connected" | "disconnected";
	view: ConversationViewLike | undefined;
	status: AgentStatus | undefined;
	error: string | undefined;
	clearError: () => void;
} {
	const connection = useMemo(() => connectAgent({ url: webSocketUrl() }), []);
	const [connectionState, setConnectionState] = useState<"connecting" | "connected" | "disconnected">("connecting");
	const [view, setView] = useState<ConversationViewLike | undefined>(undefined);
	const [status, setStatus] = useState<AgentStatus | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		const off = connection.subscribe((state) => setConnectionState(state));
		// Both states are subscribed for the page's lifetime: a Chord remote state hydrates only while subscribed.
		const offView = connection.agent.view.subscribe((value) => setView(value as ConversationViewLike | undefined));
		const offStatus = connection.agent.agentStatus.subscribe(setStatus);
		return () => {
			off();
			offView();
			offStatus();
		};
	}, [connection]);

	useEffect(() => {
		const failed = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
		connection.agent.onStatus((refStatus, refError) => {
			if (refStatus === "gone") failed(refError);
		});
		const onUnhandled = (event: PromiseRejectionEvent) => failed(event.reason);
		window.addEventListener("unhandledrejection", onUnhandled);
		return () => window.removeEventListener("unhandledrejection", onUnhandled);
	}, [connection]);

	return {
		connection,
		connectionState,
		view,
		status,
		error,
		clearError: () => setError(undefined),
	};
}

function App() {
	const { connection, connectionState, view, status, error, clearError } = useAgent();
	const [debug, setDebug] = useState(() => debugFromUrl() || window.localStorage.getItem(DEBUG_KEY) === "1");
	const [pending, setPending] = useState(false);
	const listRef = useRef<HTMLDivElement | null>(null);
	const [pinned, setPinned] = useState(true);
	const follower = useFollower(listRef, setPinned);

	const run = useCallback(async (action: () => Promise<unknown>) => {
		setPending(true);
		try {
			await action();
		} catch (reason) {
			console.error("[agent]", reason);
		} finally {
			setPending(false);
		}
	}, []);

	const bridgeFor = useCallback(
		(callId: string): WidgetBridge => ({
			sendPrompt: (args) =>
				run(() => connection.agent.submit({ content: `[WIDGET ${callId}] ${args.text}`, whenBusy: "followUp" })),
			openLink: async (args) => {
				const url = args.url;
				if (typeof url === "string" && /^https?:\/\//.test(url)) window.open(url, "_blank", "noopener");
			},
		}),
		[connection, run],
	);

	const live = liveOf(view);
	const tools = live?.tools ?? [];
	// Tool calls that already settled live in the transcript; the rest are only in the live state.
	const committedTools = (view?.entries ?? []).reduce(
		(total, entry) => total + toolCallsOf(entry.model?.[0]).length,
		0,
	);
	const busy = status?.busy ?? false;
	const queued = inboxOf(view)?.items.length ?? 0;

	return (
		<div id="app">
			<div id="main">
				<SessionBar
					connection={connectionState}
					status={status}
					toolsRunning={tools.filter((slot) => slot.status === "running").length}
					toolsTotal={committedTools + tools.length}
					inboxCount={queued}
					busy={busy}
					pending={pending}
					debug={debug}
					onToggleDebug={() => {
						setDebug((value) => {
							const next = !value;
							window.localStorage.setItem(DEBUG_KEY, next ? "1" : "0");
							return next;
						});
					}}
					onStop={() => run(() => connection.agent.abort())}
					onCompact={() => run(() => connection.agent.compact({}))}
					onReset={() => run(() => connection.agent.reset({}))}
				/>
				{error === undefined ? null : (
					<button type="button" className="error-banner" data-testid="error" onClick={clearError}>
						{error}
					</button>
				)}
				<Transcript
					view={view}
					busy={busy}
					debug={debug}
					bridgeFor={bridgeFor}
					onWithdraw={(submissionId) => run(() => connection.agent.withdrawSubmission({ submissionId }))}
					listRef={listRef}
					onOpened={(element) => follower.markOpened(element)}
					connection={connectionState}
					status={status}
					pending={pending}
					onFireHook={(hookId, payload) =>
						run(() => connection.agent.fireHook({ hookId, ...(payload === undefined ? {} : { payload }) }))
					}
					onToggleHook={(hookId, enabled) => run(() => connection.agent.toggleHook({ hookId, enabled }))}
					onToggleGenUi={(enabled) => run(() => connection.agent.setSandboxedUiEnabled({ enabled }))}
				/>
				<Composer
					busy={busy}
					enabled={connectionState === "connected" && status !== undefined}
					pending={pending}
					onSubmit={(text) => run(() => connection.agent.submit({ content: text, whenBusy: "followUp" }))}
					onSteer={(text) => run(() => connection.agent.submit({ content: text, whenBusy: "steer" }))}
				/>
				<JumpPill show={!pinned} running={busy} onClick={() => follower.jump(true)} />
			</div>
		</div>
	);
}

const container = document.getElementById("root");
if (container === null) throw new Error("missing #root");
createRoot(container).render(<App />);
