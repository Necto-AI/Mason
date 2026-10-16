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
import { AgentService, AgentStatusSchema, type AgentStatus } from "../shared/contract.ts";
import { UnknownHookError } from "./hooks.ts";
import { openAgentRuntime, type AgentRuntime, type OpenAgentRuntimeOptions } from "./runtime.ts";
import { RunRetrySupervisor, RETRY_HOOK_ID } from "./run-retry.ts";
import { deriveAgentStatus } from "./status.ts";

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
	close(): Promise<void>;
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
	const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, options);
	const webDir = options.webDir ?? resolve(repositoryRoot, "dist/web");

	const host = createHost<Principal>({
		name: "server",
		self: { kind: "server" },
		onError: (error) => console.error("[chord]", error),
	});

	host.serve(AgentService, (_input, _principal, self) => {
		const statusFor = (view: ConversationView | undefined): AgentStatus =>
			deriveAgentStatus(view, {
				hooks: runtime.hooks.list(),
				sandboxedUiEnabled: runtime.sandboxedUiEnabled(),
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
		const view = self.state("view", Type.Unknown(), { init: () => viewResource.value.value });
		const agentStatus = self.state("agentStatus", AgentStatusSchema, { init: () => statusFor(viewResource.value.value) });

		// The supervisor re-arms a run that a provider outage killed; it reads the committed view only.
		const supervisor = new RunRetrySupervisor(async (error) => {
			await runtime.hooks.fire(RETRY_HOOK_ID, error);
		}, retryOptionsFromEnv());

		self.on("viewSync", viewResource, (next, ctx) => {
			view.replace(ctx, next);
			agentStatus.replace(ctx, statusFor(next));
			supervisor.observe(next);
		});

		const refreshStatus = (ctx: Ctx): void => {
			agentStatus.replace(ctx, statusFor(view.value as ConversationView));
		};

		return {
			variant: "owner",
			view,
			agentStatus,
			submit: async ({ content, whenBusy }) => {
				// The reader is driving now: a scheduled retry would talk over them.
				supervisor.acted();
				const conversation = await runtime.conversation();
				const submission = await conversation.submit(
					{ type: "input", content, ...(whenBusy === undefined ? {} : { whenBusy }) },
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
			fireHook: async ({ hookId, payload }, ctx) => {
				if (hookId !== RETRY_HOOK_ID) supervisor.acted();
				const submission = await runtime.hooks.fire(hookId, payload);
				refreshStatus(ctx);
				return { submissionId: submission.id };
			},
			toggleHook: async ({ hookId, enabled }, ctx) => {
				runtime.hooks.setEnabled(hookId, enabled);
				refreshStatus(ctx);
			},
			setSandboxedUiEnabled: async ({ enabled }, ctx) => {
				await runtime.setSandboxedUiEnabled(enabled);
				refreshStatus(ctx);
			},
		};
	});

	const server = createServer((request, response) => {
		handleRequest(request, response, runtime, webDir).catch((error: unknown) => {
			console.error("[http]", error);
			if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
			response.end("internal error");
		});
	});
	const sockets = new WebSocketServer({ server });
	acceptWebSockets(sockets, host, { principal: () => ({ kind: "owner" }) as Principal });

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
	console.log(`personal-durable-agent listening on http://${hostname}:${boundPort}`);

	return {
		port: boundPort,
		runtime,
		host,
		async close() {
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
): Promise<void> {
	const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

	if (url.pathname === "/api/status") {
		const view = await runtime.viewState(BACKGROUND_CONTEXT);
		const status = deriveAgentStatus(view.value, {
			hooks: runtime.hooks.list(),
			sandboxedUiEnabled: runtime.sandboxedUiEnabled(),
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
		try {
			const submission = await runtime.hooks.fire(decodeURIComponent(fire[1] as string), payload);
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
