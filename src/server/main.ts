/**
 * HTTP + WebSocket server: a Chord host serving `AgentService` to browsers, the event door an
 * integration's trigger posts to, and the built web client.
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acceptWebSockets, createHost, type Ctx, type Host } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationId, ConversationView, SubmissionId } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { WebSocketServer } from "ws";
import {
	AgentService,
	AgentStatusSchema,
	QueuedItemSchema,
	TranscriptItemSchema,
	withAuthor,
	type AgentStatus,
} from "../shared/contract.ts";
import { whenBusyFor } from "./admission.ts";
import {
	authenticate,
	createTokenStore,
	ensureToken,
	joinCookie,
	pairingFromRequest,
	pairingUrls,
	type TokenRecord,
	type TokenStore,
} from "./auth.ts";
import { currentHouse, type HousePaths } from "./house.ts";
import { integrationSummaries } from "./integration-status.ts";
import { commandsFor, currentIntegrations, triggerFor } from "./integrations.ts";
import {
	COMMAND_KIND,
	EVENT_SIGNATURE_HEADER,
	EVENTS_PATH,
	commandRequestId,
	readCommand,
	readEnvelope,
	verifySignature,
	type CommandName,
} from "./events.ts";
import { explicitRequestId, UnknownHookError } from "./hooks.ts";
import {
	COMMAND_LIMIT,
	createFireLimiter,
	EVENT_BODY_MAX_BYTES,
	EVENT_FIRE_LIMIT,
	type FireLimiter,
	JSON_BODY_MAX_BYTES,
	parseJsonObject,
	readBodyCapped,
	readRawBodyCapped,
} from "./limits.ts";
import { projectQueued, projectTranscript } from "./projection.ts";
import { claimedPerson, findPerson, peopleOnWire, readRoster } from "./roster.ts";
import { openAgentRuntime, type AgentRuntime, type OpenAgentRuntimeOptions } from "./runtime.ts";
import { RunRetrySupervisor, RETRY_HOOK_ID } from "./run-retry.ts";
import { createCacheReporter, deriveAgentStatus, isBusy, queuedSubmissions, statusLine } from "./status.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Two principals: the server's own code, and a connected browser — carrying the person that browser says it is, taken
 * from the cookie at handshake.
 *
 * The person rides here rather than in the method arguments because the server, not the caller, has to be the one who
 * writes the author into the transcript. It is part of the principal's key (see `principalKey`), because the object's
 * key is the only place caller identity survives a call: a method's `ctx` acts as the host.
 */
type Principal = { kind: "owner"; person?: string } | { kind: "server" };

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".map": "application/json; charset=utf-8",
	".woff2": "font/woff2",
};

export interface StartServerOptions extends OpenAgentRuntimeOptions {
	readonly port?: number;
	readonly hostname?: string;
	/** Directory holding the built client (`index.html`, `main.js`, `main.css`). */
	readonly webDir?: string;
}

export interface RunningServer {
	readonly port: number;
	readonly runtime: AgentRuntime;
	/** `AgentService` reached over the server's own host, for tests and scripts. */
	readonly host: Host<Principal>;
	/**
	 * The token this process minted for a home that had none, so a test (or the log line) can pair without reading a
	 * hash. Absent on a restart: the plaintext is shown once and never stored.
	 */
	readonly pairingToken: string | undefined;
	close(): Promise<void>;
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
	const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, options);
	const webDir = options.webDir ?? resolve(repositoryRoot, "dist/web");

	// The prompt-cache report, one line per finished run. The watch is the server's own, not a browser's — a run
	// finishes whether or not anyone is looking at it.
	const conversation = await runtime.conversation();
	const runWatch = await conversation.watch(BACKGROUND_CONTEXT);
	const reportRun = createCacheReporter((line) => console.log(line));
	// A run the last process left unfinished is counted from the moment this process attached, so its first line
	// under-reports the tokens it spent before the restart.
	reportRun(runWatch.value);
	runWatch.start(async (view) => reportRun(view));

	const host = createHost<Principal>({
		name: "server",
		self: { kind: "server" },
		// The factory is handed the principal of the connection that created the object, but every method runs in a
		// context acting as the *host* principal (`CtxImpl.child`), so one *shared* object could not tell later callers
		// apart: caller identity exists only in the object's key. Keying on the person is therefore what makes the author
		// readable in `submit` at all. Every unnamed browser still shares one object — the conversation is shared, and so
		// is what mirrors it — and a named person mirrors it once for themselves.
		principalKey: (principal) => (principal.kind === "owner" ? `owner:${principal.person ?? ""}` : principal.kind),
		onError: (error) => console.error("[chord]", error),
	});

	// The supervisor re-arms a run that a provider outage killed; it reads the committed view only. One for the server,
	// not one per object: it is a policy over the one shared conversation, and a copy per person would each fire its own
	// retry for the same failure.
	const supervisor = new RunRetrySupervisor(async (error) => {
		// A retry is a gesture: each attempt is its own fire, and resuming from its own context never resurrects one.
		await runtime.hooks.fire(RETRY_HOOK_ID, { payload: error });
	}, retryOptionsFromEnv());

	host.serve(AgentService, (_input, principal, self) => {
		// The person this object was created for: fixed at handshake, and the only identity a method can see.
		const author = principal.kind === "owner" ? principal.person : undefined;

		const statusFor = (view: ConversationView | undefined): AgentStatus =>
			deriveAgentStatus(view, {
				hooks: runtime.hooks.list(),
				model: runtime.model,
				cwd: runtime.workspaceDir,
			});

		// `viewState()` is the durable conversation's own watch of the view; this object mirrors it into its
		// own cell so every connected browser gets snapshots and structural diffs.
		const viewResource = self.resource("viewState", {
			version: 1,
			open: async ({ signal }) => runtime.viewState(withAbortSignal(signal, BACKGROUND_CONTEXT)),
			close: (view) => view.dispose(),
		});
		// The raw view never leaves the server: the cells below are the projection in `projection.ts`, which forwards the
		// reader's transcript and the queue and nothing else — no entries, no reasoning, no tool calls, no usage.
		const transcript = self.state("transcript", Type.Array(TranscriptItemSchema), {
			init: () => projectTranscript(viewResource.value.value),
		});
		const queued = self.state("queued", Type.Array(QueuedItemSchema), {
			init: () => projectQueued(viewResource.value.value),
		});
		const agentStatus = self.state("agentStatus", AgentStatusSchema, { init: () => statusFor(viewResource.value.value) });

		self.on("viewSync", viewResource, (next, ctx) => {
			transcript.replace(ctx, projectTranscript(next));
			queued.replace(ctx, projectQueued(next));
			agentStatus.replace(ctx, statusFor(next));
			supervisor.observe(next);
		});

		const refreshStatus = (ctx: Ctx): void => {
			agentStatus.replace(ctx, statusFor(viewResource.value.value));
		};

		return {
			variant: "owner",
			transcript,
			queued,
			agentStatus,
			submit: async ({ content, whenBusy }) => {
				// The reader is driving now: a scheduled retry would talk over them.
				supervisor.acted();
				const conversation = await runtime.conversation();
				const placement = whenBusyFor("user", whenBusy);
				// The author is written here, not sent by the client: the name on a message is the server's claim, and it is
				// the same string the model reads and the reader sees as a chip.
				const submission = await conversation.submit(
					{
						type: "input",
						content: withAuthor(content, author),
						...(placement === undefined ? {} : { whenBusy: placement }),
					},
					BACKGROUND_CONTEXT,
				);
				return { submissionId: submission.id };
			},
			withdrawSubmission: async ({ submissionId }) => {
				// Chord carries JSON: a submission ID crosses as a number and comes back as one.
				const submission = await runtime.harness.submission(submissionId as SubmissionId, BACKGROUND_CONTEXT);
				await submission?.abort(BACKGROUND_CONTEXT);
			},
			abort: async () => {
				await (await runtime.conversation()).abort(BACKGROUND_CONTEXT);
			},
			reset: async (args) => {
				await (await runtime.conversation()).reset(args?.handoff, BACKGROUND_CONTEXT);
			},
			compact: async (args) => {
				await (await runtime.conversation()).compact(args?.instructions, BACKGROUND_CONTEXT);
			},
			fireHook: async ({ hookId, payload, requestId }, ctx) => {
				if (hookId !== RETRY_HOOK_ID) supervisor.acted();
				// Pressing a control in the transcript is a gesture: no id means one fire per press. A caller that does
				// have an event identity passes it, and is deduplicated exactly like a named delivery.
				const submission = await runtime.hooks.fire(hookId, {
					...(payload === undefined ? {} : { payload }),
					...(requestId === undefined ? {} : { requestId: explicitRequestId(hookId, requestId) }),
				});
				refreshStatus(ctx);
				return { submissionId: submission.id };
			},
			toggleHook: async ({ hookId, enabled }, ctx) => {
				runtime.hooks.setEnabled(hookId, enabled);
				refreshStatus(ctx);
			},
		};
	});

	// One owner, a few credentials, and a session key for the browser's cookie. The store is the config file, read per
	// request: a revoke lands on the next request rather than on the next restart, which is the moment it matters.
	const house = currentHouse();
	const store = createTokenStore(house.home);
	const { token: pairingToken } = await ensureToken(house.home);
	// One limiter for the process: its budget is what this process may spend, so it is shared across requests.
	const fires = createFireLimiter();

	const server = createServer((request, response) => {
		handleRequest(request, response, runtime, webDir, store, fires, house).catch((error: unknown) => {
			console.error("[http]", error);
			if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
			response.end("internal error");
		});
	});
	const sockets = new WebSocketServer({ server });
	// A socket is the reader: no credential, no owner. Chord closes the link itself when the principal is `undefined`.
	acceptWebSockets(sockets, host, {
		principal: async (request): Promise<Principal | undefined> => {
			const auth = await authenticate(request, store);
			if (!auth.ok) {
				console.warn(`[auth] refused a socket (${auth.reason}) from ${request.headers.origin ?? "a program"}`);
				return undefined;
			}
			// A removed person keeps their cookie but loses the socket: the roster is re-read here, so a removal lands on
			// the next connection rather than on the next restart. A session that outlives its roster entry would let a
			// removed person keep speaking under their old name.
			const person = await claimedPerson(house, auth.person);
			if (auth.person !== undefined && person === undefined) {
				console.warn(`[auth] refused a socket for ${auth.person}: not on the roster`);
				return undefined;
			}
			return person === undefined ? { kind: "owner" } : { kind: "owner", person: person.name };
		},
	});

	const port = options.port ?? Number(process.env.PORT ?? 8787);
	const hostname = options.hostname ?? process.env.HOST ?? "127.0.0.1";
	await new Promise<void>((ready, failed) => {
		server.once("error", failed);
		server.listen(port, hostname, () => {
			server.off("error", failed);
			ready();
		});
	});
	const address = server.address();
	const boundPort = typeof address === "object" && address !== null ? address.port : port;
	console.log(`mason listening on http://${hostname}:${boundPort}`);
	console.log(`[data] ${runtime.dataDir}`);
	// A state directory next to the code was the old default; saying so is worth more than silently starting a second
	// agent that looks empty. Only for a server that took the default: a caller that passed `dataDir` (a test, a script)
	// has already decided where its state is.
	if (options.dataDir === undefined && resolve(runtime.dataDir) !== resolve(".data") && existsSync(join(".data", "agent.sqlite"))) {
		console.warn(`[data] ignoring ./.data (an older home): move it with \`mv .data ${runtime.dataDir}\``);
	}
	if (pairingToken !== undefined) {
		console.log(`[auth] minted a token for this home; open one of these once, per browser or device:`);
		for (const url of pairingUrls(hostname, boundPort, pairingToken)) console.log(`[auth]   ${url}`);
		console.log(`[auth] the link sets a cookie and redirects to the bare page; the token stays out of the address bar`);
	} else {
		const known = (await store.records()).length;
		console.log(`[auth] ${known} token(s); add one with: npm run token -- add --label phone (a revoke is live)`);
	}
	// A roster nobody filled in is the team feature nobody can use: the shell sends a paired browser to a picker with no
	// names on it, and this line is what tells the deployer why, and what to type.
	if ((await readRoster(house)).people.length === 0) {
		console.warn(`[team] the roster is empty: add the first person with: npm run team -- add "Ilya" (a removal is live)`);
	}
	if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
		console.log(`[auth] ${hostname} is not loopback: the token crosses the network in clear text until TLS lands`);
	}

	return {
		port: boundPort,
		runtime,
		host,
		pairingToken,
		async close() {
			// Stop the telemetry watch first: nothing it reports is worth waiting for a shutting-down process.
			await runWatch.stop();
			// `WebSocketServer.close()` only calls back once every client has gone, and a browser holds its socket
			// open: terminate the clients first, or shutdown waits forever.
			for (const client of sockets.clients) client.terminate();
			await new Promise<void>((closed) => sockets.close(() => closed()));
			await new Promise<void>((closed) => {
				server.close(() => closed());
				server.closeAllConnections();
			});
			await host.close();
			await runtime.close();
		},
	};
}

/**
 * What a command acts on, apart from the door: the three conversation methods the console already calls, the claim that
 * makes an envelope id an identity, whether the conversation is busy, and the line `status` answers.
 *
 * A port rather than `AgentRuntime` so a test can hand the dispatch a stub conversation and read what a command did,
 * without a provider, a turn or a second of waiting. The six methods are the whole of what a command may do, so a new
 * command means changing this interface as well as the vocabulary in `events.ts`.
 */
export interface CommandTarget {
	abort(): Promise<void>;
	clear(): Promise<void>;
	compact(instructions: string | undefined): Promise<void>;
	status(): Promise<string>;
	/**
	 * Whether the conversation is working or has anything waiting — the same two facts `/status` reads out of the view.
	 * `/clear` asks because a reset is not display-only: it queues behind a running turn, so this is the difference
	 * between "cleared" and "the answer you just cleared is still coming".
	 */
	busy(): Promise<boolean>;
	/**
	 * Claims this command's id in the durable log, and answers whether the claim is new. A redelivery finds the claim and
	 * is answered with nothing at all, so nothing runs twice.
	 */
	claim(requestId: string, command: CommandName, argument: string | undefined): Promise<boolean>;
}

/** What the three commands that change something answer a chat, in one word each: the person knows what happened. */
const ONE_WORD: Record<"stop" | "compact" | "clear", string> = {
	stop: "stopped",
	compact: "compacted",
	clear: "cleared",
};

/** What `/clear` answers when the reset is queued behind a turn: the person is told what is going to happen, not asked. */
const CLEARING_AFTER_TURN = "clearing after this turn";

/**
 * One declared command, run once per envelope id, and the line the chat gets back — or nothing at all when the log
 * already held this command's id, which is the caller's cue to say `already ran` and answer with an empty reply.
 *
 * The dedupe is the durable log's own: a command's request id is admitted like a fire's, and the log never forgets one,
 * so a redelivery after a restart answers what it answered instead of stopping a second turn or clearing a conversation
 * that has moved on. `status` is not claimed, because it changes nothing and a claim would be a record of something that
 * did not happen: a retried question is still a question.
 *
 * **Where the claim sits is a trade, and it differs per command — deliberately.** `stop` aborts first and claims second:
 * `abort` is idempotent, so stopping a turn that is already stopped costs nothing, where claiming first would turn a
 * *failed* abort into a permanent "stopped" — the log would hold a stop that never happened, and no redelivery could
 * retry it because the id was already spent. `clear` and `compact` claim first: a repeated clear throws away a
 * conversation that has moved on and a repeated compact spends a second model call, so a redelivery that does nothing is
 * the better half of that trade. The abort is not gated on its claim — only the reply is; tidying the three into one rule
 * breaks one of them whichever rule you pick.
 *
 * Nothing here waits for a running turn: `abort`, `reset` and `compact` are the conversation's own methods, and the claim
 * is a display-only entry, which the log appends at once even mid-run — `/stop` is the whole point of that. `clear` is the
 * one that is not display-only: the reset is a write the log queues behind the turn, which is why the answer says it is
 * queueing rather than pretending the conversation is already empty.
 */
export async function runCommand(
	target: CommandTarget,
	requestId: string,
	command: CommandName,
	argument: string | undefined,
): Promise<string | undefined> {
	switch (command) {
		case "status":
			return target.status();
		case "stop": {
			// The act comes first and nothing is gated on the claim, so a redelivery that reached here before its own first
			// delivery finished did no harm — the turn is stopped either way. The claim's answer decides the reply alone.
			await target.abort();
			return (await target.claim(requestId, command, argument)) ? ONE_WORD.stop : undefined;
		}
		case "compact": {
			if (!(await target.claim(requestId, command, argument))) return undefined;
			await target.compact(argument);
			return ONE_WORD.compact;
		}
		case "clear": {
			if (!(await target.claim(requestId, command, argument))) return undefined;
			// Asked before the act, because the question is "will the reset land now, or behind the turn?" — a reset submits a
			// write with `head: "self"`, which is not display-only, so on a busy conversation it queues in the inbox and returns
			// at once. Either way the reset happens; only the answer differs, and "cleared" over a conversation that is still
			// delivering the answer it was told to forget is a lie the person watches come true.
			const busy = await target.busy();
			await target.clear();
			return busy ? CLEARING_AFTER_TURN : ONE_WORD.clear;
		}
		default: {
			// Every name in `COMMAND_NAMES` has an arm above, and this line is what makes a fifth one a compile error rather
			// than a command that answers nothing.
			const unhandled: never = command;
			throw new Error(`no arm for command ${String(unhandled)}`);
		}
	}
}

/** The entry a command leaves behind: the record that makes its id an identity, and the trace of what a chat asked for. */
const COMMAND_ENTRY_KIND = "app.command";

/** The real target: the root conversation the console drives, the durable log that remembers a command's id, and the
 * status line this boot derives. */
async function commandTarget(runtime: AgentRuntime): Promise<CommandTarget> {
	const conversation = await runtime.conversation();
	return {
		abort: () => conversation.abort(BACKGROUND_CONTEXT),
		clear: () => conversation.reset(undefined, BACKGROUND_CONTEXT),
		compact: async (instructions) => {
			await conversation.compact(instructions, BACKGROUND_CONTEXT);
		},
		status: async () =>
			statusLine(await runtime.viewSnapshot(BACKGROUND_CONTEXT), integrationSummaries(currentIntegrations())),
		busy: async () => {
			const view = await runtime.viewSnapshot(BACKGROUND_CONTEXT);
			return isBusy(view) || queuedSubmissions(view) > 0;
		},
		// One commit: the lookup, the entry and the submission that names it are the claim, so two deliveries of one id
		// cannot both find it absent. The entry carries no model content, which is what makes it display-only — the log
		// appends it at once instead of queueing it behind the turn the command is about.
		claim: (requestId, command, argument) =>
			conversation.commit(async (tx) => {
				if ((await tx.submissionByRequest(conversation.id, requestId)) !== undefined) return false;
				const entry = await tx.appendEntry(conversation.id, {
					kind: COMMAND_ENTRY_KIND,
					data: { command, ...(argument === undefined ? {} : { argument }) },
				});
				await tx.createSubmission({
					conversationId: conversation.id,
					requestId,
					type: "write",
					status: "done",
					entry: entry.id,
				});
				return true;
			}, BACKGROUND_CONTEXT),
	};
}

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	runtime: AgentRuntime,
	webDir: string,
	store: TokenStore,
	fires: FireLimiter,
	house: HousePaths,
): Promise<void> {
	const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
	// Every response carries these, refusals and static files alike: the shell has no inline script of its own, and a
	// paired browser is never framed by someone else's page.
	applySecurityHeaders(response, request.headers.host);

	// A pairing link is the one time a token travels in a URL. Spend it into a cookie and send the browser to the same
	// page without it: the token leaves the address bar before a single element renders.
	if ((request.method ?? "GET") === "GET" && isShellPath(url.pathname)) {
		const pairing = await pairingFromRequest(request, url, store);
		if (pairing !== undefined) {
			console.log(`[auth] paired ${pairing.tokenId} in this browser`);
			response.writeHead(302, { location: withoutToken(url), "set-cookie": pairing.cookie });
			response.end();
			return;
		}
	}

	// Everything under `/api` is the owner's, except two doors that cannot present a token: the liveness probe, and
	// the event door, which is authenticated by the sender's own HMAC below (src/server/events.ts) and can do exactly one
	// of the things its entry declares: fire its hook, or issue one of its commands. The static shell is public on purpose:
	// it is a bundle with no secrets in it, and the page is where a reader is told that this browser is not paired.
	let device: TokenRecord | undefined;
	let claimed: string | undefined;
	const eventDoor = eventDoorPath(url.pathname);
	if (url.pathname.startsWith("/api/") && url.pathname !== "/api/health" && eventDoor === undefined) {
		const auth = await authenticate(request, store);
		if (!auth.ok) {
			console.warn(`[auth] refused ${request.method ?? "GET"} ${url.pathname} (${auth.reason})`);
			response.writeHead(401, {
				"content-type": "application/json; charset=utf-8",
				"www-authenticate": 'Bearer realm="mason"',
			});
			response.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		device = auth.token;
		claimed = auth.person;
	}

	// A name is a place in the room, not a permanent badge: removing a person from the roster ends their access on the
	// next request, while their cookie — signed, and still valid — waits for them to be added back.
	const person = await claimedPerson(house, claimed);
	if (claimed !== undefined && person === undefined) {
		console.warn(`[auth] refused ${url.pathname} for ${claimed}: not on the roster`);
		response.writeHead(401, { "content-type": "application/json; charset=utf-8" });
		response.end(JSON.stringify({ error: "not on the roster" }));
		return;
	}

	// The event door: one path, one verb, and one of the two effects its entry declares — one fire of the hook the
	// integration's trigger names (§3.3), or one of the commands that trigger may issue. The path names the integration;
	// the boot resolved which ones are enabled, and a delivery is never a way to read, claim or call. A misspelt name, a
	// disabled integration and one with no trigger all answer `404` like a path that is not a door, because which of them
	// it is is not a sender's business.
	if (eventDoor !== undefined) {
		if (eventDoor === "malformed") {
			console.warn(`[events] refused a delivery to ${url.pathname}: the path names no integration`);
			return notFound(response);
		}
		const name = eventDoor.name;
		const trigger = triggerFor(currentIntegrations(), name);
		if (trigger === undefined) {
			console.warn(`[events] refused a delivery to ${name}: no enabled trigger face there`);
			return notFound(response);
		}
		if (request.method !== "POST") return json(response, 405, { error: "method not allowed" });
		const raw = await readRawBodyCapped(request, EVENT_BODY_MAX_BYTES);
		if (raw === undefined) {
			console.warn(`[events] refused a delivery for ${name}: over ${EVENT_BODY_MAX_BYTES} bytes`);
			response.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
			response.end(JSON.stringify({ error: "payload too large", maxBytes: EVENT_BODY_MAX_BYTES }));
			return;
		}
		// The signature is the door: it is checked over the raw bytes, before a single field is parsed, and a refusal says
		// nothing about which half failed.
		if (!verifySignature(trigger.secret, raw, headerValue(request, EVENT_SIGNATURE_HEADER))) {
			console.warn(`[events] refused a delivery for ${name}: bad or missing signature`);
			return json(response, 401, { error: "unauthorized" });
		}
		const envelope = readEnvelope(raw);
		if ("error" in envelope) {
			console.warn(`[events] refused a delivery for ${name}: ${envelope.error}`);
			return json(response, 400, { error: envelope.error });
		}
		if (envelope.kind === COMMAND_KIND) {
			// A command has a budget of its own, and it is not the fire budget. Both are a bill — `/compact` is a model call —
			// but a person who has just sent six messages must still be able to say `/stop`, and a chat that spent the
			// integration's minute on messages would otherwise be unable to interrupt the turn those messages started.
			const reading = readCommand(envelope.payload, commandsFor(currentIntegrations(), name));
			if ("error" in reading) {
				console.warn(`[events] refused a command for ${name}: ${reading.error}`);
				return json(response, 400, { error: reading.error });
			}
			if ("undeclared" in reading) {
				// Not a refusal: the sender typed something mason has no use for, and it still has a message in hand. Saying so is
				// what keeps `/start`, `/foo` and a mistaken `/stopp` ordinary text instead of an error.
				return json(response, 200, { handled: false });
			}
			// The budget is spent here, immediately before the dispatch, and nowhere above it: only a command mason will act
			// on is a bill. A word it does not declare and a malformed one are neither acted on nor charged, because they must
			// not be able to spend the minute a real `/stop` needs — six `/stopp` used to make the seventh command a `429`,
			// which is the opposite of what the separate budget was for.
			const wait = fires.take(`command:${name}`);
			if (wait !== undefined) {
				console.warn(`[events] refused a command for ${name}: ${COMMAND_LIMIT} a minute is the budget`);
				response.writeHead(429, { "content-type": "application/json; charset=utf-8", "retry-after": String(wait) });
				response.end(JSON.stringify({ error: "too many commands", retryAfterSeconds: wait }));
				return;
			}
			const reply = await runCommand(
				await commandTarget(runtime),
				commandRequestId(name, envelope.id),
				reading.command,
				reading.argument,
			);
			if (reply === undefined) {
				// The log held this command's id, so nothing ran this time: the first delivery already answered, and the relay
				// suppresses an empty reply (`integrations/telegram/src/door.ts`), so a redelivery says nothing in the chat and
				// the audit line does not claim an act that did not happen.
				console.log(`[events] ${name} already ran ${reading.command} for ${envelope.id}`);
				return json(response, 200, { handled: true, reply: "" });
			}
			console.log(`[events] ${name} ran ${reading.command} for ${envelope.id}`);
			return json(response, 200, { handled: true, reply });
		}
		// A fire is a whole turn, and a loop of them is a bill. The key is the integration's own, so one chatty sender cannot
		// spend another's minute. Checked after the body only because a command is the one delivery that must survive a
		// sender's spent budget: the body is capped, and a forged signature is refused before this line.
		const wait = fires.take(`integration:${name}`);
		if (wait !== undefined) {
			console.warn(`[events] refused a delivery for ${name}: ${EVENT_FIRE_LIMIT} a minute is the budget`);
			response.writeHead(429, { "content-type": "application/json; charset=utf-8", "retry-after": String(wait) });
			response.end(JSON.stringify({ error: "too many deliveries", retryAfterSeconds: wait }));
			return;
		}
		try {
			// `id` is the delivery's identity, so a redelivery is this same fire however much later it arrives; `payload` is
			// the sender's text, which the hooks engine fences as untrusted data before the model reads it. The id is unique
			// within the integration, so the integration's name is part of the key: two integrations on one hook that both call
			// a delivery `1` are two events, and the loser does not get a `202` for a fire someone else's event already made.
			// `kind` is carried for the log and the prompt label only.
			const submission = await runtime.hooks.fire(trigger.hook, {
				payload: envelope.payload,
				kind: envelope.kind,
				requestId: explicitRequestId(trigger.hook, `${name}:${envelope.id}`),
			});
			console.log(`[events] ${name} fired ${trigger.hook} for ${envelope.kind} ${envelope.id}`);
			return json(response, 202, { submissionId: submission.id });
		} catch (error) {
			if (error instanceof UnknownHookError) {
				// Boot validation should have refused this process; a `500` here means the hook list changed under a boot.
				console.warn(`[events] ${name} fires ${trigger.hook}, which is not a hook`);
				return json(response, 500, { error: "the integration's hook is not a hook" });
			}
			throw error;
		}
	}

	// Who this browser is, for the shell to tell "not paired" from "paired but quiet". Behind the gate above.
	// The roster rides along only for a browser that has not claimed a name: it is the list the picker shows, and a
	// browser that already speaks for someone has no use for it.
	if (url.pathname === "/api/session") {
		const roster = claimed === undefined ? peopleOnWire(await readRoster(house)) : undefined;
		return json(response, 200, {
			device: { id: device?.id, label: device?.label },
			...(person === undefined ? {} : { person: { name: person.name } }),
			...(roster === undefined ? {} : { roster }),
		});
	}

	// The join screen's only write: claim a name off the roster. A claim, not an authentication — anyone holding a token
	// can pick any name on the list — so the route is the roster that makes it meaningful, and removing a person is
	// what ends it.
	if (url.pathname === "/api/join") {
		if ((request.method ?? "GET") === "GET") {
			return json(response, 200, {
				people: peopleOnWire(await readRoster(house)),
				...(person === undefined ? {} : { person: { name: person.name } }),
			});
		}
		if (request.method !== "POST") return json(response, 405, { error: "method not allowed" });
		const text = await readBodyCapped(request);
		if (text === undefined) {
			response.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
			response.end(JSON.stringify({ error: "payload too large", maxBytes: JSON_BODY_MAX_BYTES }));
			return;
		}
		const body = parseJsonObject(text);
		const wanted = typeof body.name === "string" ? body.name : "";
		const chosen = findPerson(await readRoster(house), wanted);
		if (chosen === undefined || device === undefined) return json(response, 404, { error: "not on the roster" });
		const cookie = joinCookie(request, await store.config(), device.id, chosen.name);
		if (cookie === undefined) return json(response, 500, { error: "this home has no session key" });
		response.setHeader("set-cookie", cookie);
		return json(response, 200, { person: { name: chosen.name } });
	}

	if (url.pathname === "/api/status") {
		const view = await runtime.viewSnapshot(BACKGROUND_CONTEXT);
		const status = deriveAgentStatus(view, {
			hooks: runtime.hooks.list(),
			model: runtime.model,
			cwd: runtime.workspaceDir,
		});
		return json(response, 200, status);
	}

	// What this boot's integration list is, and whether its servers answered. Behind the same gate as the rest of `/api`,
	// and the only place health appears: a prompt section that carried it would differ between two turns of one build.
	if (url.pathname === "/api/integrations") {
		return json(response, 200, { integrations: integrationSummaries(currentIntegrations()) });
	}

	const health: string = "ok";
	if (url.pathname === "/api/health") return json(response, 200, { status: health, root: String(runtime.rootId) });

	return serveStatic(response, webDir, url.pathname);
}

/**
 * Headers every response carries. The shell has no inline script of its own, and a paired browser must not be framed
 * by someone else's page: clickjacking a cookie-authenticated UI is the one attack the Origin gate cannot see, because
 * the framed page really is ours.
 */
function applySecurityHeaders(response: ServerResponse, host: string | undefined): void {
	response.setHeader("referrer-policy", "no-referrer");
	response.setHeader("x-content-type-options", "nosniff");
	response.setHeader("x-frame-options", "DENY");
	response.setHeader("content-security-policy", contentSecurityPolicy(host));
}

/**
 * The shell's policy, which the widget frames inherit: a `srcdoc` iframe gets the embedder's CSP, so this has to be a
 * superset of what a widget needs (`src/web/lib/frame-content.ts` carries the same list as a `<meta>`).
 *
 * `'unsafe-inline'` is the cost of running a widget's own script at all; what remains enforced is what an injected
 * script would otherwise be free to do — frame this origin, retarget every relative URL through `<base>`, post a form
 * to another host, or open a socket anywhere but here and the CDN the widget imports from.
 */
function contentSecurityPolicy(host: string | undefined): string {
	const cdn = "https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com";
	return [
		"default-src 'self'",
		`script-src 'self' 'unsafe-inline' 'unsafe-eval' ${cdn}`,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob: https://basemap.nationalmap.gov https://upload.wikimedia.org https://thumb.wikimedia.org",
		"font-src 'self' data:",
		`connect-src 'self'${socketOrigins(host)} ${cdn}`,
		"media-src 'self' data: blob:",
		"frame-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	].join("; ");
}

/**
 * The socket's own origin, for browsers that do not read `'self'` as covering `ws://`.
 *
 * The host comes from a request header, so it is checked rather than trusted: a value with a `;` in it would otherwise
 * end our directive and start one of the sender's choosing.
 */
function socketOrigins(host: string | undefined): string {
	if (host === undefined || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) return "";
	return ` ws://${host} wss://${host}`;
}

/**
 * Where a path stands with the generic event door: the integration it names, `"malformed"` for one of the door's own bad
 * shapes, or `undefined` for a path that is not the door at all.
 *
 * The bare prefix counts, and so does anything under it: a sender that lost the integration name, or added a second
 * segment, gets the door's `404` rather than the token gate's `401`. A door whose bad shapes look like a missing cookie
 * is a door whose operator cannot tell a broken sender from a broken pairing. A name is exactly one segment, and the
 * gate and the route read the same answer, so a path cannot be outside the gate and inside the door.
 */
function eventDoorPath(pathname: string): { readonly name: string } | "malformed" | undefined {
	if (pathname !== EVENTS_PATH.slice(0, -1) && !pathname.startsWith(EVENTS_PATH)) return undefined;
	const name = pathname.startsWith(EVENTS_PATH) ? pathname.slice(EVENTS_PATH.length) : "";
	return name === "" || name.includes("/") ? "malformed" : { name };
}

/** The pages a pairing link may land on: the shell, and the shell's file name. */
function isShellPath(pathname: string): boolean {
	return pathname === "/" || pathname === "/index.html" || pathname === "/join";
}

/** The page a pairing link redirects to: the same URL with the token spent and dropped. */
function withoutToken(url: URL): string {
	const params = new URLSearchParams(url.search);
	params.delete("token");
	const search = params.toString();
	return `${url.pathname}${search === "" ? "" : `?${search}`}`;
}

async function serveStatic(response: ServerResponse, webDir: string, pathname: string): Promise<void> {
	// `/join` is a door into the same shell, not a second page: the bundle decides what to draw from the session it
	// finds, and a pairing link may land on this path as easily as on the root.
	if (pathname === "/join") pathname = "/";
	const relativePath = normalize(pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
	if (relativePath.startsWith("..")) return notFound(response);
	const path = resolve(webDir, relativePath);
	if (!path.startsWith(resolve(webDir))) return notFound(response);
	try {
		const info = await stat(path);
		if (!info.isFile()) return notFound(response);
	} catch {
		return notFound(response);
	}
	const body = await readFile(path);
	response.writeHead(200, { "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream" });
	response.end(body);
}

/**
 * Retry schedule overrides, for tests and for a deployment that wants a different patience:
 * `PDA_RUN_RETRY_DELAYS_MS="1000,5000"` and `PDA_RUN_RETRY_ATTEMPTS=2`.
 */
function retryOptionsFromEnv(): { delaysMs?: number[]; maxAttempts?: number } {
	const delays = process.env.PDA_RUN_RETRY_DELAYS_MS?.split(",")
		.map((value) => Number(value.trim()))
		.filter((value) => Number.isFinite(value) && value >= 0);
	// An unset or blank variable must stay unset here, or `Number("")`'s 0 would read as "the supervisor is off".
	const attemptsEnv = process.env.PDA_RUN_RETRY_ATTEMPTS?.trim();
	const attempts = attemptsEnv === undefined || attemptsEnv === "" ? Number.NaN : Number(attemptsEnv);
	return {
		...(delays === undefined || delays.length === 0 ? {} : { delaysMs: delays }),
		// `0` means the supervisor is off entirely (the budget is spent from the start): tests use it to keep a
		// failed run failed.
		...(Number.isFinite(attempts) && attempts >= 0 ? { maxAttempts: attempts } : {}),
	};
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
	response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body));
}

function notFound(response: ServerResponse): void {
	response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	response.end("not found");
}

/** One request header as a string; repeated headers are not a thing a delivery sends, so the first is the value. */
function headerValue(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

/** `ConversationId` of the root conversation, for scripts and logs. */
export type { ConversationId };

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	const server = await startServer();
	const stop = async (): Promise<void> => {
		await server.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void stop());
	process.on("SIGTERM", () => void stop());
}
