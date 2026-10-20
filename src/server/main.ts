/**
 * HTTP + WebSocket server: a Chord host serving `AgentService` to browsers, the webhook trigger for
 * event hooks, and the built web client.
 */
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
	type AgentStatus,
} from "../shared/contract.ts";
import { whenBusyFor } from "./admission.ts";
import { authenticate, ensureToken, pairingUrls, type TokenRecord } from "./auth.ts";
import { currentHouse } from "./house.ts";
import { bodyRequestId, explicitRequestId, UnknownHookError } from "./hooks.ts";
import { projectQueued, projectTranscript } from "./projection.ts";
import { openAgentRuntime, type AgentRuntime, type OpenAgentRuntimeOptions } from "./runtime.ts";
import { RunRetrySupervisor, RETRY_HOOK_ID } from "./run-retry.ts";
import { createCacheReporter, deriveAgentStatus } from "./status.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Two principals by kind: the server's own code, and a connected browser the app calls the owner. */
type Principal = { kind: "owner" } | { kind: "server" };

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
		onError: (error) => console.error("[chord]", error),
	});

	host.serve(AgentService, (_input, _principal, self) => {
		const statusFor = (view: ConversationView | undefined): AgentStatus =>
			deriveAgentStatus(view, {
				hooks: runtime.hooks.list(),
				model: runtime.model,
				cwd: runtime.workspaceDir,
			});

		// `viewState()` is the durable conversation's own Chord state; this object mirrors it into its
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

		// The supervisor re-arms a run that a provider outage killed; it reads the committed view only.
		const supervisor = new RunRetrySupervisor(async (error) => {
			// A retry is a gesture: each attempt is its own fire, and resuming from its own context never resurrects one.
			await runtime.hooks.fire(RETRY_HOOK_ID, { payload: error });
		}, retryOptionsFromEnv());

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
				const submission = await conversation.submit(
					{ type: "input", content, ...(placement === undefined ? {} : { whenBusy: placement }) },
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
				// have an event identity passes it, and is deduplicated exactly like a named webhook delivery.
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

	// One owner, a few credentials. Read once per process: a token minted while the server runs is picked up by the
	// next start, which is what `npm run token -- revoke` says.
	const { token: pairingToken, records: tokens } = await ensureToken(currentHouse().home);

	const server = createServer((request, response) => {
		handleRequest(request, response, runtime, webDir, tokens).catch((error: unknown) => {
			console.error("[http]", error);
			if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
			response.end("internal error");
		});
	});
	const sockets = new WebSocketServer({ server });
	// A socket is the reader: no token, no owner. Chord closes the link itself when the principal is `undefined`.
	acceptWebSockets(sockets, host, {
		principal: (request) => {
			const auth = authenticate(request, tokens);
			if (!auth.ok) {
				console.warn(`[auth] refused a socket (${auth.reason}) from ${request.headers.origin ?? "a program"}`);
				return undefined;
			}
			return { kind: "owner" } as Principal;
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
	if (pairingToken !== undefined) {
		console.log(`[auth] minted a token for this home; open one of these once, per browser or device:`);
		for (const url of pairingUrls(hostname, boundPort, pairingToken)) console.log(`[auth]   ${url}`);
	} else {
		console.log(`[auth] ${tokens.length} token(s); add one with: npm run token -- add --label phone`);
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

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	runtime: AgentRuntime,
	webDir: string,
	tokens: readonly TokenRecord[],
): Promise<void> {
	const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

	// Everything under `/api` is the owner's, except the liveness probe. The static shell is public on purpose: it is
	// a bundle with no secrets in it, and the page is where a reader is told that this browser is not paired.
	if (url.pathname.startsWith("/api/") && url.pathname !== "/api/health") {
		const auth = authenticate(request, tokens);
		if (!auth.ok) {
			console.warn(`[auth] refused ${request.method ?? "GET"} ${url.pathname} (${auth.reason})`);
			response.writeHead(401, {
				"content-type": "application/json; charset=utf-8",
				"www-authenticate": 'Bearer realm="mason"',
			});
			response.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
	}

	if (url.pathname === "/api/status") {
		const view = await runtime.viewState(BACKGROUND_CONTEXT);
		const status = deriveAgentStatus(view.value, {
			hooks: runtime.hooks.list(),
			model: runtime.model,
			cwd: runtime.workspaceDir,
		});
		view.dispose();
		return json(response, 200, status);
	}

	const fire = /^\/api\/hooks\/([^/]+)\/fire$/.exec(url.pathname);
	if (fire !== null && request.method === "POST") {
		const body = await readJson(request);
		const payload =
			typeof body.message === "string" ? body.message : typeof body.data === "string" ? body.data : undefined;
		const hookId = decodeURIComponent(fire[1] as string);
		// A webhook delivery has an identity. A sender that names it is exact and permanent; one that cannot is one
		// event per body per window, so its queue's redelivery collapses while tomorrow's identical body still fires.
		const senderId = senderRequestId(request, body);
		try {
			const submission = await runtime.hooks.fire(hookId, {
				...(payload === undefined ? {} : { payload }),
				requestId:
					senderId === undefined
						? bodyRequestId(hookId, body, Date.now())
						: explicitRequestId(hookId, senderId),
			});
			return json(response, 200, { submissionId: submission.id });
		} catch (error) {
			if (error instanceof UnknownHookError) return json(response, 404, { error: error.message });
			throw error;
		}
	}

	const health: string = "ok";
	if (url.pathname === "/api/health") return json(response, 200, { status: health, root: String(runtime.rootId) });

	return serveStatic(response, webDir, url.pathname);
}

async function serveStatic(response: ServerResponse, webDir: string, pathname: string): Promise<void> {
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

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	if (chunks.length === 0) return {};
	try {
		const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** The id a webhook sender gave its delivery: in the JSON body or the `x-request-id` header, else none. */
function senderRequestId(request: IncomingMessage, body: Record<string, unknown>): string | undefined {
	if (typeof body.requestId === "string" && body.requestId !== "") return body.requestId;
	const header = request.headers["x-request-id"];
	const value = Array.isArray(header) ? header[0] : header;
	return value === undefined || value === "" ? undefined : value;
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
