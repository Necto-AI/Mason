/**
 * HTTP + WebSocket server: the operator panel and its API, the connector door, and the built web client.
 *
 * There is no conversational socket any more (#103): a person speaks to mason through a connector, and the panel is a
 * control plane that reads the projected conversation and administers the deployment. What used to be a Chord service
 * with a state per browser is now `/api/admin/state` (`admin.ts`), and the browser's grant decides which keys it holds.
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { WebSocketServer } from "ws";
import { handleOperatorRequest } from "./admin.ts";
import { ATTACHMENT_LIMIT, AttachmentStore } from "./attachments.ts";
import {
	authenticate,
	createTokenStore,
	ensureToken,
	grantsOf,
	hasGrant,
	pairingFromRequest,
	pairingUrls,
	type TokenRecord,
	type TokenStore,
} from "./auth.ts";
import { CONNECTOR_PATH, type ConnectorDoor, createConnectorDoor } from "./connector.ts";
import { authenticateConnector } from "./connectors.ts";
import { currentHouse, type HousePaths } from "./house.ts";
import { installEnvHttpProxy } from "./http-proxy.ts";
import { integrationSummaries } from "./integration-status.ts";
import { currentIntegrations } from "./integrations.ts";
import { createFireLimiter, type FireLimiter, readRawBodyCapped } from "./limits.ts";
import { claimedPerson, readRoster } from "./roster.ts";
import { RETRY_HOOK_ID, RunRetrySupervisor } from "./run-retry.ts";
import { type AgentRuntime, type OpenAgentRuntimeOptions, openAgentRuntime } from "./runtime.ts";
import { createCacheReporter, deriveAgentStatus } from "./status.ts";

export { type CommandTarget, commandTarget, runCommand } from "./commands.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

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
	/** Directory holding the built panel (`index.html`, `admin.js`, `admin.css`). */
	readonly webDir?: string;
	/**
	 * The attachment store's bounds. Defaults are the protocol's (25 MiB, a day); a test that has to cross the cap or wait
	 * for an expiry sets them small rather than writing 25 MB or sleeping a day.
	 */
	readonly attachmentBytes?: number;
	readonly attachmentTtlMs?: number;
}

export interface RunningServer {
	readonly port: number;
	readonly runtime: AgentRuntime;
	/**
	 * The token this process minted for a home that had none, so a test (or the log line) can pair without reading a
	 * hash. Absent on a restart: the plaintext is shown once and never stored.
	 */
	readonly pairingToken: string | undefined;
	/** The connector door, for a test that reads its live sessions rather than driving a socket. */
	readonly connectors: ConnectorDoor;
	close(): Promise<void>;
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
	// Before the runtime: a provider client captures `fetch` when it is built, so the dispatcher has to be installed
	// before the first one exists. A stack with no proxy in its environment is untouched, which is every stack with a
	// direct route to its provider.
	installEnvHttpProxy();
	const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, options);
	const webDir = options.webDir ?? resolve(repositoryRoot, "dist/web");

	// The supervisor re-arms a run that a provider outage killed; it reads the committed view only. One for the server,
	// not one per object: it is a policy over the one shared conversation, and a copy per person would each fire its own
	// retry for the same failure.
	const retryOptions = retryOptionsFromEnv();
	const supervisor = new RunRetrySupervisor(async (error, origin) => {
		// A retry is a gesture: each attempt is its own fire, and resuming from its own context never resurrects one. It
		// carries the origin of the turn it resumes, so the retry's `reply` goes back to whoever was waiting (#83).
		await runtime.hooks.fire(RETRY_HOOK_ID, { payload: error, ...(origin === undefined ? {} : { origin }) });
	}, retryOptions);

	// The prompt-cache report, one line per finished run. The watch is the server's own, not a browser's — a run
	// finishes whether or not anyone is looking at it.
	//
	// The supervisor reads the same watch, and for the same reason: the person waiting on a failed run is usually not
	// the one with the UI open. Fed from a connection instead, it observed nothing at all whenever nobody had a browser
	// on the conversation, and a run that a provider killed stayed dead until somebody wrote again (2026-10-30: a bot's
	// two messages sat unanswered for 3 and 12 hours while the log held no `[run-retry]` line at all).
	const conversation = await runtime.conversation();
	const runWatch = await conversation.watch(BACKGROUND_CONTEXT);
	const reportRun = createCacheReporter((line) => console.log(line));
	console.log(
		retryOptions.maxAttempts === 0
			? "[run-retry] off: a failed run is left to the retry hook"
			: `[run-retry] a failed run is re-armed after ${supervisor.delaysMs.map((ms) => `${Math.round(ms / 1000)}s`).join(", ")}`,
	);
	// A run the last process left unfinished is counted from the moment this process attached, so its first line
	// under-reports the tokens it spent before the restart. The supervisor is given the same first value: a failure
	// that the previous process died on is still a task nobody answered.
	reportRun(runWatch.value);
	supervisor.observe(runWatch.value);
	// The failure branch is the watch saying it cannot read the view any more; nothing reaches the supervisor from it,
	// because a supervisor told about a run nobody can read is a supervisor that retries on a guess.
	runWatch.start(async (call) => {
		if (call.kind !== "value") {
			console.error("[run] the conversation view failed", call.error);
			return;
		}
		reportRun(call.value);
		supervisor.observe(call.value);
	});

	// One owner, a few credentials, and a session key for the browser's cookie. The store is the config file, read per
	// request: a revoke lands on the next request rather than on the next restart, which is the moment it matters.
	const house = currentHouse();
	const store = createTokenStore(house.home);
	const { token: pairingToken } = await ensureToken(house.home);
	// One limiter for the process: its budget is what this process may spend, so it is shared across requests. The
	// connector classes beside it are keyed per connector, so one sender's minute is never another's.
	const fires = createFireLimiter();
	// Uploaded bytes and the ids that point at them. Durable, in the home's data half: a restart between an upload and the
	// submission that references it is the moment a resend happens.
	const attachments = new AttachmentStore({
		dataDir: runtime.dataDir,
		...(options.attachmentBytes === undefined ? {} : { maxBytes: options.attachmentBytes }),
		...(options.attachmentTtlMs === undefined ? {} : { ttlMs: options.attachmentTtlMs }),
	});
	// The connector door: one JSON-RPC socket per connector, the state mirrors and the reply outbox. Opened before the
	// listener so a delivery cannot be owed before there is anything to send it with.
	const connectors = await createConnectorDoor({
		runtime,
		workspaceDir: runtime.workspaceDir,
		attachments,
		limiter: fires,
		permissions: runtime.permissions,
		home: house.home,
	});

	const server = createServer((request, response) => {
		handleRequest(request, response, runtime, webDir, store, fires, house, attachments).catch((error: unknown) => {
			console.error("[http]", error);
			if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
			response.end("internal error");
		});
	});
	// One socket server behind the listener: a connector's JSON-RPC door. There is no browser socket any more — the
	// panel polls `/api/admin/state`, and nothing else in a browser speaks to mason. `noServer` because the path in the
	// upgrade request decides whether there is a door at all, and a path that is not the connector's opens none.
	const connectorSockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
	server.on("upgrade", (request, socket, head) => {
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		if (pathname !== CONNECTOR_PATH) {
			socket.destroy();
			return;
		}
		connectorSockets.handleUpgrade(request, socket, head, (client) =>
			connectorSockets.emit("connection", client, request),
		);
	});
	connectorSockets.on("connection", (socket, request) => {
		void connectors.attach(socket, request);
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
	if (
		options.dataDir === undefined &&
		resolve(runtime.dataDir) !== resolve(".data") &&
		existsSync(join(".data", "agent.sqlite"))
	) {
		console.warn(`[data] ignoring ./.data (an older home): move it with \`mv .data ${runtime.dataDir}\``);
	}
	if (pairingToken !== undefined) {
		console.log(`[auth] minted a token for this home; open one of these once, per browser or device:`);
		for (const url of pairingUrls(hostname, boundPort, pairingToken)) console.log(`[auth]   ${url}`);
		console.log(
			`[auth] the link sets a cookie and redirects to the bare page; the token stays out of the address bar`,
		);
	} else {
		const known = (await store.records()).length;
		// A credential written before grants existed opens the door and sees nothing: the boot says why, once, next to
		// the command that fixes it. The fix is not done here — a server that rewrote the operator's files on start would
		// be a server that edits his home.
		const ungranted = (await store.records()).filter((record) => !Array.isArray(record.grants));
		if (ungranted.length > 0) {
			console.warn(
				`[auth] ${ungranted.length} credential(s) predate grants and can see nothing of the panel: ` +
					"run `npm run doctor -- migrate` once (the tokens keep what the console could do, and never trace)",
			);
		}
		console.log(
			`[auth] ${known} token(s); add one with: npm run token -- add --label phone (a revoke is live). ` +
				"The panel is /admin; the server log names the tokens and their grants.",
		);
	}
	// A roster nobody filled in is the team feature nobody can use: the shell sends a paired browser to a picker with no
	// names on it, and this line is what tells the deployer why, and what to type.
	if ((await readRoster(house)).people.length === 0) {
		console.warn(
			`[team] the roster is empty: add the first person with: npm run team -- add "Ilya" (a removal is live)`,
		);
	}
	if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
		console.log(`[auth] ${hostname} is not loopback: the token crosses the network in clear text until TLS lands`);
	}

	return {
		port: boundPort,
		runtime,
		pairingToken,
		connectors,
		async close() {
			// Nothing the supervisor still owes is worth a fire into a closed runtime: a shutdown is the last thing that
			// drops a pending re-fire.
			supervisor.close();
			// Stop the telemetry watch first: nothing it reports is worth waiting for a shutting-down process.
			await runWatch.stop();
			// The door first: it stops the state watch and closes every connector socket, and a delivery that arrives during
			// shutdown should not start an outbox flush against a runtime that is about to close.
			await connectors.close();
			// `WebSocketServer.close()` only calls back once every client has gone, and a connector holds its socket
			// open: terminate the clients first, or shutdown waits forever.
			for (const client of connectorSockets.clients) client.terminate();
			await new Promise<void>((closed) => connectorSockets.close(() => closed()));
			await new Promise<void>((closed) => {
				server.close(() => closed());
				server.closeAllConnections();
			});
			await runtime.close();
		},
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
	attachments: AttachmentStore,
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

	// The connector's own door: its socket's upgrade is routed elsewhere, but the attachment endpoints are HTTP and are
	// authenticated by the connector's credential rather than the owner's token. Handled before the gate below, because
	// an owner token is not a connector credential and a connector credential is not a token.
	if (await handleConnectorRequest(request, response, url, attachments, fires, house)) return;

	// Everything under `/api` is the owner's, except one door that cannot present a token: the liveness probe. The static
	// shell is public on purpose: it is a bundle with no secrets in it, and the page is where a reader is told that this
	// browser is not paired.
	let device: TokenRecord | undefined;
	let claimed: string | undefined;
	if (url.pathname.startsWith("/api/") && url.pathname !== "/api/health") {
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

	// Who this device is, and what it may do in the panel. Behind the gate above, and the only route the panel calls
	// before it knows what to draw: `grants` is the answer, and every area of the state it polls is absent unless one of
	// them covers it (`admin.ts`).
	if (url.pathname === "/api/session") {
		return json(response, 200, {
			device: { id: device?.id, label: device?.label },
			...(person === undefined ? {} : { person: { name: person.name } }),
			grants: device === undefined ? [] : grantsOf(device),
			// The join screen is gone with the console, but a cookie signed before today still names a person, and a
			// device that has none is told so rather than shown an empty name.
			joined: person !== undefined,
		});
	}

	// The operator's control plane: the state the granted areas of the panel read, the configuration it writes, and the
	// two approval routes. `admin.ts` owns the grant checks; this file only routes to it, and a path it does not know is
	// a `404` rather than a request nobody ever answers.
	if (
		url.pathname.startsWith("/api/admin/") ||
		url.pathname === "/api/admin" ||
		url.pathname === "/api/permissions" ||
		url.pathname.startsWith("/api/permissions/")
	) {
		if (device === undefined) return json(response, 401, { error: "unauthorized" });
		const handled = await handleOperatorRequest(request, response, url, {
			runtime,
			house,
			store,
			device,
			...(person === undefined ? {} : { person: person.name }),
		});
		if (!handled) notFound(response);
		return;
	}

	// Status and health are areas of the panel's state (§4.2), served here for a script that asks one question: the
	// same grant covers them, so a device with no grants cannot read what its state would not carry.
	if (url.pathname === "/api/status") {
		if (device === undefined || !hasGrant(grantsOf(device), "conversation")) {
			return json(response, 403, { error: 'this device has no "conversation" grant' });
		}
		const view = await runtime.viewSnapshot(BACKGROUND_CONTEXT);
		const status = deriveAgentStatus(view, {
			hooks: runtime.hooks.list(),
			model: runtime.model,
			cwd: runtime.workspaceDir,
		});
		return json(response, 200, status);
	}

	// What this boot's integration list is, and whether its servers answered. Administrative, like the panel's own
	// health table: it names services and why they are unreachable.
	if (url.pathname === "/api/integrations") {
		if (device === undefined || !hasGrant(grantsOf(device), "admin")) {
			return json(response, 403, { error: 'this device has no "admin" grant' });
		}
		return json(response, 200, { integrations: integrationSummaries(currentIntegrations()) });
	}

	const health: string = "ok";
	if (url.pathname === "/api/health") return json(response, 200, { status: health, root: String(runtime.rootId) });

	return serveStatic(response, webDir, url.pathname);
}

/**
 * The connector's HTTP endpoints: `POST /api/connector/attachments` and `GET /api/connector/attachments/<contentId>`.
 *
 * Authenticated as the connector (`authenticateConnector`), never as the owner, and answered with the protocol's own
 * statuses: `413` over the cap, `410` for an id that expired, `404` for one this connector did not upload — which is the
 * same answer a malformed id gets, because whether another connector's id exists is not a sender's business. The budget
 * is the connector's attachment class, separate from its submissions, fires and controls.
 */
async function handleConnectorRequest(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	attachments: AttachmentStore,
	fires: FireLimiter,
	house: HousePaths,
): Promise<boolean> {
	if (url.pathname !== CONNECTOR_PATH && !url.pathname.startsWith(`${CONNECTOR_PATH}/`)) return false;
	// `/api/connector` itself is a WebSocket. An HTTP request there is a client that forgot how the door works.
	if (url.pathname === CONNECTOR_PATH) {
		notFound(response);
		return true;
	}
	const auth = await authenticateConnector(request, house.home, currentIntegrations());
	if (!auth.ok) {
		console.warn(`[connector] refused ${request.method ?? "GET"} ${url.pathname} (${auth.reason})`);
		response.writeHead(401, {
			"content-type": "application/json; charset=utf-8",
			"www-authenticate": 'Bearer realm="mason-connector"',
		});
		response.end(JSON.stringify({ code: "mason.not_authenticated", message: "a connector credential is required" }));
		return true;
	}
	const name = auth.identity.name;
	// Which of the two endpoints, and whether this request is one mason will act on — settled before the budget is
	// charged, so a wrong verb or an unknown path costs the connector nothing.
	const base = `${CONNECTOR_PATH}/attachments`;
	const uploading = url.pathname === base;
	if (!uploading && !url.pathname.startsWith(`${base}/`)) {
		notFound(response);
		return true;
	}
	if (request.method !== (uploading ? "POST" : "GET")) {
		json(response, 405, { error: "method not allowed" });
		return true;
	}
	const wait = fires.take(`connector:attachment:${name}`, ATTACHMENT_LIMIT);
	if (wait !== undefined) {
		response.writeHead(429, {
			"content-type": "application/json; charset=utf-8",
			"retry-after": String(wait),
		});
		response.end(
			JSON.stringify({
				code: "mason.rate_limited",
				message: `this connector has spent its ${ATTACHMENT_LIMIT}-a-minute attachment budget`,
				retryable: true,
				retryAfterMs: Math.min(wait * 1000, 60_000),
			}),
		);
		return true;
	}
	if (uploading) {
		const raw = await readRawBodyCapped(request, attachments.maxBytes);
		if (raw === undefined) {
			response.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
			response.end(
				JSON.stringify({
					code: "mason.invalid_request",
					message: `that upload is over ${attachments.maxBytes} bytes`,
				}),
			);
			return true;
		}
		const filename = headerValue(request, "x-mason-filename");
		const meta = await attachments.save(name, raw, {
			mimeType: headerValue(request, "content-type"),
			...(filename === undefined ? {} : { name: safeFilename(filename) }),
		});
		if (meta === undefined) {
			response.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
			response.end(JSON.stringify({ code: "mason.invalid_request", message: "that upload is over the cap" }));
			return true;
		}
		json(response, 200, { contentId: meta.contentId, size: meta.size, expiresAt: meta.expiresAt });
		return true;
	}
	// A malformed escape is a content id nobody uploaded, which is the same answer as one this connector did not upload.
	let contentId: string;
	try {
		contentId = decodeURIComponent(url.pathname.slice(base.length + 1));
	} catch {
		notFound(response);
		return true;
	}
	const read = await attachments.read(name, contentId);
	if (read.status === "expired") {
		response.writeHead(410, { "content-type": "application/json; charset=utf-8" });
		response.end(JSON.stringify({ code: "mason.invalid_request", message: "that content id expired" }));
		return true;
	}
	if (read.status === "missing") {
		notFound(response);
		return true;
	}
	response.writeHead(200, {
		"content-type": read.attachment.meta.mimeType,
		"content-length": String(read.attachment.meta.size),
		"cache-control": "no-store",
		...(read.attachment.meta.name === undefined
			? {}
			: { "x-mason-filename": encodeURIComponent(read.attachment.meta.name) }),
	});
	response.end(read.attachment.bytes);
	return true;
}

/** A filename from a header, decoded and reduced to a name: it is shown and written, never used as a path. */
function safeFilename(value: string): string | undefined {
	let decoded: string;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		return undefined;
	}
	const name = decoded
		.replace(/[\u0000-\u001f\u007f/\\]+/g, "_")
		.trim()
		.slice(0, 120);
	return name === "" ? undefined : name;
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
 * to another host, or reach anything but this origin and the CDN the widget imports from. There is no browser socket
 * to allow: the panel polls `/api/admin/state` on this origin, and `connect-src 'self'` is the whole of it.
 */
function contentSecurityPolicy(_host: string | undefined): string {
	const cdn = "https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com";
	return [
		"default-src 'self'",
		`script-src 'self' 'unsafe-inline' 'unsafe-eval' ${cdn}`,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob: https://basemap.nationalmap.gov https://upload.wikimedia.org https://thumb.wikimedia.org",
		"font-src 'self' data:",
		`connect-src 'self' ${cdn}`,
		"media-src 'self' data: blob:",
		"frame-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	].join("; ");
}

/** The pages a pairing link may land on: the panel, and the panel's two spellings. */
function isShellPath(pathname: string): boolean {
	return pathname === "/" || pathname === "/index.html" || pathname === "/admin" || pathname === "/admin/";
}

/** The page a pairing link redirects to: the same URL with the token spent and dropped. */
function withoutToken(url: URL): string {
	const params = new URLSearchParams(url.search);
	params.delete("token");
	const search = params.toString();
	return `${url.pathname}${search === "" ? "" : `?${search}`}`;
}

async function serveStatic(response: ServerResponse, webDir: string, pathname: string): Promise<void> {
	// `/admin` is a door into the same shell, not a second page: the bundle draws the panel from the session it finds,
	// and a pairing link may land on this path as easily as on the root.
	if (pathname === "/" || pathname === "/admin" || pathname === "/admin/") pathname = "/";
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
	// Never cached: an upgraded mason serves a new bundle under the same name, and an operator's browser running the
	// previous one is a panel that lies about the deployment it is looking at.
	response.writeHead(200, {
		"content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
		"cache-control": "no-store",
	});
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
