/**
 * The client shell: connect to the server's Chord host, keep a subscription on the state it publishes, and render the
 * session bar, the transcript (with its queue and working line) and the composer.
 *
 * The state is the reader's, not the machine's: a transcript of messages, widgets and triggers, the queue behind the
 * running turn, and a status. Reasoning, tool calls and tool output are not part of the contract, so this file cannot
 * show them even by accident.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentStatus, QueuedItem, TranscriptItem } from "../shared/contract.ts";
import { connectAgent, type AgentConnection } from "./client.ts";
import { Composer } from "./components/Composer.tsx";
import { JumpPill } from "./components/JumpPill.tsx";
import { Picker } from "./components/Picker.tsx";
import { SessionBar } from "./components/SessionBar.tsx";
import { Transcript } from "./components/Transcript.tsx";
import { useFollower } from "./lib/follower.ts";
import { probeSession, screenFor, type BrowserSession, socketUrl } from "./lib/session.ts";
import type { WidgetBridge } from "./lib/websandbox-loader.ts";
import { createWorkingMachine } from "./lib/working.ts";
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
 * Whether this browser may see the agent, asked once at boot. The answer decides between three screens, and only the
 * conversation opens a socket: the door, the picker a paired browser with no name is sent to, and the conversation.
 */
type Boot =
	| { readonly state: "probing" }
	| { readonly state: "unreachable" }
	| { readonly state: "answered"; readonly session: BrowserSession | undefined };

function Root() {
	const [boot, setBoot] = useState<Boot>({ state: "probing" });
	useEffect(() => {
		probeSession()
			.then((session) => setBoot({ state: "answered", session }))
			.catch(() => setBoot({ state: "unreachable" }));
	}, []);
	if (boot.state === "probing") return null;
	if (boot.state === "unreachable") return <Unpaired reason="unreachable" />;
	const screen = screenFor(boot.session);
	if (screen.kind === "unpaired") return <Unpaired reason="unpaired" />;
	if (screen.kind === "join") return <Picker roster={screen.roster} />;
	return <App person={screen.person} />;
}

function App({ person }: { readonly person: string | undefined }) {
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
			sendPrompt: (args) => {
				// A message sent from inside a widget is still the reader sending: it lands below the fold of what they
				// were looking at, so the view goes to it.
				follower.glide();
				return run(() =>
					connection.agent.submit({ content: `[WIDGET ${callId}] ${args.text}`, whenBusy: "followUp" }),
				);
			},
			openLink: async (args) => {
				const url = args.url;
				if (typeof url === "string" && /^https?:\/\//.test(url)) window.open(url, "_blank", "noopener");
			},
		}),
		[connection, run],
	);

	const busy = status?.busy ?? false;
	// One machine per mounted app: its memory of the last tool is the whole point, so a fresh one per render would
	// reproduce the flicker. The machine answers from the status; this effect feeds it and wakes it when a held name
	// has had its time.
	const workingMachine = useMemo(() => createWorkingMachine(), []);
	const [working, setWorking] = useState<string | undefined>(undefined);
	// Before paint: a turn that just ended should not leave the previous line on screen for a frame.
	useLayoutEffect(() => {
		const apply = () => setWorking(workingMachine.label(status));
		apply();
		const remaining = workingMachine.holdRemainingMs();
		if (remaining === undefined) return;
		const timer = setTimeout(apply, remaining);
		return () => clearTimeout(timer);
	}, [workingMachine, status]);

	return (
		<div id="app">
			<div id="main">
				<SessionBar
					status={status}
					person={person}
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
					person={person}
					bridgeFor={bridgeFor}
					connection={connectionState}
					onWithdraw={(submissionId) => run(() => connection.agent.withdrawSubmission({ submissionId }))}
				/>
				<Composer
					busy={busy}
					enabled={connectionState === "connected" && status !== undefined}
					pending={pending}
					connection={connectionState}
					onSubmit={(text) => {
						// Before the submit, not after: the row arrives a round trip later, and the glide is already under
						// way by then rather than starting from a still view.
						follower.glide();
						return run(() => connection.agent.submit({ content: text, whenBusy: "followUp" }));
					}}
					onSteer={(text) => {
						follower.glide();
						return run(() => connection.agent.submit({ content: text, whenBusy: "steer" }));
					}}
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
