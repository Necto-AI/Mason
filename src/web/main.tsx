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
import { probeSession, type SessionDevice, socketUrl } from "./lib/session.ts";
import type { WidgetBridge } from "./lib/websandbox-loader.ts";
import { workingLabel } from "./lib/working.ts";
import "./styles/tokens.css";
import "./styles/chat.css";

function useAgent(): {
	connection: AgentConnection;
	connectionState: "connecting" | "connected" | "disconnected";
	transcript: TranscriptItem[];
	queued: QueuedItem[];
	status: AgentStatus | undefined;
	error: string | undefined;
	clearError: () => void;
} {
	const connection = useMemo(() => connectAgent({ url: socketUrl(window.location) }), []);
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
 * What a browser without a cookie sees. The server printed a pairing link when it minted a token, and opening that
 * link once is the whole step: it sets a cookie and redirects here. An empty transcript would look like a broken agent
 * instead of a closed door.
 */
function Unpaired({ reason }: { readonly reason: "unpaired" | "unreachable" }) {
	return (
		<div id="app">
			<div id="main">
				<div className="unpaired" data-testid={reason === "unpaired" ? "unpaired" : "unreachable"}>
					<h1>{reason === "unpaired" ? "Not paired" : "Server not answering"}</h1>
					{reason === "unpaired" ? (
						<>
							<p>
								This browser has no session. Open the pairing link the server printed — it looks like{" "}
								<code>http://127.0.0.1:8787/?token=…</code> — once, and this page will remember the browser.
							</p>
							<p>
								No link? Mint one on the machine: <code>npm run token -- add --label browser</code>.
							</p>
						</>
					) : (
						<p>
							The page loaded but <code>/api/session</code> did not answer. Is the server running, on this address?
						</p>
					)}
				</div>
			</div>
		</div>
	);
}

/**
 * Whether this browser may see the agent, asked once at boot. The answer decides between two screens, and only one of
 * them opens a socket.
 */
function Root() {
	const [session, setSession] = useState<SessionDevice | "probing" | "unreachable" | undefined>("probing");
	useEffect(() => {
		probeSession()
			.then(setSession)
			.catch(() => setSession("unreachable"));
	}, []);
	if (session === "probing") return null;
	if (session === "unreachable") return <Unpaired reason="unreachable" />;
	return session === undefined ? <Unpaired reason="unpaired" /> : <App />;
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
createRoot(container).render(<Root />);
