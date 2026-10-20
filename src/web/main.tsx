/**
 * The client shell: connect to the server's Chord host, keep a subscription on the state it publishes, and render the
 * session bar, the transcript (with its queue and working line) and the composer.
 *
 * The state is the reader's, not the machine's: a transcript of messages, widgets and triggers, the queue behind the
 * running turn, and a status. Reasoning, tool calls and tool output are not part of the contract, so this file cannot
 * show them even by accident.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentStatus, QueuedItem, TranscriptItem } from "../shared/contract.ts";
import { connectAgent, type AgentConnection } from "./client.ts";
import { Composer } from "./components/Composer.tsx";
import { JumpPill } from "./components/JumpPill.tsx";
import { SessionBar } from "./components/SessionBar.tsx";
import { Transcript } from "./components/Transcript.tsx";
import { useFollower } from "./lib/follower.ts";
import { adoptToken, socketUrl } from "./lib/token.ts";
import type { WidgetBridge } from "./lib/websandbox-loader.ts";
import { workingLabel } from "./lib/working.ts";
import "./styles/tokens.css";
import "./styles/chat.css";

/** This browser's credential: taken from `?token=` once, then kept. `undefined` means the browser is not paired. */
const token = adoptToken(window);

function useAgent(): {
	connection: AgentConnection;
	connectionState: "connecting" | "connected" | "disconnected";
	transcript: TranscriptItem[];
	queued: QueuedItem[];
	status: AgentStatus | undefined;
	error: string | undefined;
	clearError: () => void;
} {
	const connection = useMemo(
		() => connectAgent({ url: socketUrl(window.location, token) }),
		[],
	);
	const [connectionState, setConnectionState] = useState<"connecting" | "connected" | "disconnected">("connecting");
	const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
	const [queued, setQueued] = useState<QueuedItem[]>([]);
	const [status, setStatus] = useState<AgentStatus | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		const off = connection.subscribe((state) => setConnectionState(state));
		// Every cell is subscribed for the page's lifetime: a Chord remote state hydrates only while subscribed.
		const offTranscript = connection.agent.transcript.subscribe((value) => setTranscript(value ?? []));
		const offQueued = connection.agent.queued.subscribe((value) => setQueued(value ?? []));
		const offStatus = connection.agent.agentStatus.subscribe(setStatus);
		return () => {
			off();
			offTranscript();
			offQueued();
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
		transcript,
		queued,
		status,
		error,
		clearError: () => setError(undefined),
	};
}

/**
 * What a browser without a token sees. The server printed a link when it minted one, and pasting that link is the whole
 * pairing step: an empty transcript would look like a broken agent instead of a browser that is not allowed in.
 */
function Unpaired() {
	return (
		<div id="app">
			<div id="main">
				<div className="unpaired" data-testid="unpaired">
					<h1>Not paired</h1>
					<p>
						This browser has no token. Open the link the server printed on its first start — it looks like{" "}
						<code>http://127.0.0.1:8787/?token=…</code> — once, and this page will remember it.
					</p>
					<p>
						Lost it? Mint another on the machine: <code>npm run token -- add --label browser</code>.
					</p>
				</div>
			</div>
		</div>
	);
}

function App() {
	const { connection, connectionState, transcript, queued, status, error, clearError } = useAgent();
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

	const busy = status?.busy ?? false;
	const working = workingLabel(status);

	return (
		<div id="app">
			<div id="main">
				<SessionBar
					status={status}
					onCompact={() => run(() => connection.agent.compact({}))}
					onReset={() => run(() => connection.agent.reset({}))}
				/>
				{error === undefined ? null : (
					<button type="button" className="error-banner" data-testid="error" onClick={clearError}>
						{error}
					</button>
				)}
				<Transcript
					transcript={transcript}
					queued={queued}
					working={working}
					bridgeFor={bridgeFor}
					connection={connectionState}
					onWithdraw={(submissionId) => run(() => connection.agent.withdrawSubmission({ submissionId }))}
				/>
				<Composer
					busy={busy}
					enabled={connectionState === "connected" && status !== undefined}
					pending={pending}
					connection={connectionState}
					onSubmit={(text) => run(() => connection.agent.submit({ content: text, whenBusy: "followUp" }))}
					onSteer={(text) => run(() => connection.agent.submit({ content: text, whenBusy: "steer" }))}
					onStop={() => run(() => connection.agent.abort())}
				/>
				<JumpPill show={!pinned} running={busy} onClick={() => follower.jump(true)} />
			</div>
		</div>
	);
}

const container = document.getElementById("root");
if (container === null) throw new Error("missing #root");
createRoot(container).render(token === undefined ? <Unpaired /> : <App />);
