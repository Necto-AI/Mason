/**
 * The Streamable HTTP endpoint, and nothing beside it.
 *
 * One path (`/mcp`) and one process: the container never publishes a port, is reachable only by name on `mason-mcp`,
 * and the only client is mason's boot. Everything else is a `404`, which is the smallest surface that can still be a
 * tools face.
 *
 * **Stateless on purpose.** No `Mcp-Session-Id`, no per-session state: mason opens one connection at boot and keeps it,
 * but a session that outlives neither side is a thing to expire, resume and apologise for, and both tools here are
 * independent calls. So every request gets its own `McpServer` and transport over the same three tools, and either end
 * restarting is a reconnect rather than a stale session.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MCP_PATH } from "./constants.ts";
import { describeError, type Log } from "./log.ts";
import { createMcpServer, type TelegramTools } from "./mcp.ts";

export interface McpHttpOptions {
	readonly port: number;
	readonly tools: TelegramTools;
	readonly log: Log;
	/** The interface to bind. `0.0.0.0` inside a container, because `127.0.0.1` there is the container and nobody is on it. */
	readonly host?: string;
}

export interface RunningMcpServer {
	readonly port: number;
	close(): Promise<void>;
}

export async function startMcpHttp(options: McpHttpOptions): Promise<RunningMcpServer> {
	const server: Server = createServer((request, response) => {
		void handle(request, response, options);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host ?? "0.0.0.0", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : options.port;
	options.log("info", `tools face listening on http://0.0.0.0:${port}${MCP_PATH}`);
	return {
		port,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				// A keep-alive connection from mason would otherwise hold the close open until the container is killed.
				server.closeAllConnections();
			}),
	};
}

async function handle(request: IncomingMessage, response: ServerResponse, options: McpHttpOptions): Promise<void> {
	const pathname = (request.url ?? "/").split("?", 1)[0] ?? "/";
	if (pathname !== MCP_PATH) {
		response.writeHead(404, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: `mason-telegram answers ${MCP_PATH} and nothing else` }));
		return;
	}
	// One server and one transport per request: that is what stateless means here, and closing both on the response's
	// end is what keeps a long-lived container from accumulating them.
	const mcpServer = createMcpServer(options.tools);
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	response.on("close", () => {
		void transport.close().catch(() => {});
		void mcpServer.close().catch(() => {});
	});
	try {
		await mcpServer.connect(transport);
		await transport.handleRequest(request, response);
	} catch (error) {
		options.log("error", `the tools face failed a request: ${describeError(error)}`);
		if (!response.headersSent) {
			response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "internal error" }));
		}
	}
}
