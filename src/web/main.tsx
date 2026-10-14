/**
 * The mobile client: connect to the server's Chord host, keep a subscription on the conversation state, and
 * render the transcript, the status line, the queue, the hooks drawer and the composer.
 */
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentStatus } from "../shared/contract.ts";
import { connectAgent, type AgentConnection } from "./client.ts";
import { Composer } from "./components/Composer.tsx";
import { HooksPanel } from "./components/HooksPanel.tsx";
import { InboxBar } from "./components/InboxBar.tsx";
import { StatusBanner } from "./components/StatusBanner.tsx";
import { TranscriptView } from "./components/TranscriptView.tsx";
import type { WidgetBridge } from "./lib/websandbox-loader.ts";
import { inbox as inboxOf, live as liveOf, toolCallsOf, type ConversationViewLike } from "./view-types.ts";
import "./styles/app.css";

function webSocketUrl(): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${window.location.host}/`;
}

function useAgent(): {
	connection: AgentConnection;
	connectionState: string;
	view: ConversationViewLike | undefined;
	status: AgentStatus | undefined;
	error: string | undefined;
	clearError: () => void;
} {
	const connection = useMemo(() => connectAgent({ url: webSocketUrl() }), []);
	const [connectionState, setConnectionState] = useState<string>("connecting");
	const [view, setView] = useState<ConversationViewLike | undefined>(undefined);
	const [status, setStatus] = useState<AgentStatus | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		const off = connection.subscribe(setConnectionState);
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
	const [hooksOpen, setHooksOpen] = useState(false);
	const [pending, setPending] = useState(false);

	const run = useCallback(
		async (action: () => Promise<unknown>) => {
			setPending(true);
			try {
				await action();
			} catch (reason) {
				console.error("[agent]", reason);
			} finally {
				setPending(false);
			}
		},
		[],
	);

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
	const queued = inboxOf(view)?.items ?? [];
	const busy = status?.busy ?? false;
	const model = status?.model;

	return (
		<div className="app">
			<StatusBanner
				connection={connectionState as "connecting" | "connected" | "disconnected"}
				status={status}
				toolsRunning={tools.filter((slot) => slot.status === "running").length}
				toolsTotal={committedTools + tools.length}
				inboxCount={queued.length}
				pending={pending}
				onToggleGenUi={(enabled) => run(() => connection.agent.setSandboxedUiEnabled({ enabled }))}
				onOpenHooks={() => setHooksOpen((open) => !open)}
			/>
			{error === undefined ? null : (
				<div className="error" data-testid="error" onClick={clearError}>
					{error}
				</div>
			)}
			<HooksPanel
				status={status}
				open={hooksOpen}
				pending={pending}
				onClose={() => setHooksOpen(false)}
				onToggle={(hookId, enabled) => run(() => connection.agent.toggleHook({ hookId, enabled }))}
				onFire={(hookId, payload) => run(() => connection.agent.fireHook({ hookId, ...(payload === undefined ? {} : { payload }) }))}
			/>
			<TranscriptView view={view} bridgeFor={bridgeFor} />
			<InboxBar inbox={inboxOf(view)} onWithdraw={(submissionId) => run(() => connection.agent.withdrawSubmission({ submissionId }))} />
			<Composer
				busy={busy}
				disabled={connectionState !== "connected" || status === undefined}
				pending={pending}
				onSend={(text) => run(() => connection.agent.submit({ content: text, whenBusy: "followUp" }))}
				onSteer={(text) => run(() => connection.agent.submit({ content: text, whenBusy: "steer" }))}
				onStop={() => run(() => connection.agent.abort())}
				onCompact={() => run(() => connection.agent.compact({}))}
				onReset={() => run(() => connection.agent.reset({}))}
			/>
			<footer className="foot">
				<span>{model === undefined ? "connecting" : `${model.provider}/${model.modelId}`}</span>
				<span>{status?.cwd ?? ""}</span>
			</footer>
		</div>
	);
}

const container = document.getElementById("root");
if (container === null) throw new Error("missing #root");
createRoot(container).render(<App />);
