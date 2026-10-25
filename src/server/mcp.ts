/**
 * MCP: what an integration's tools face lends the bot, reached once at boot.
 *
 * An integration is a service with up to two faces (ADR-0003), and this is the tools half: one `McpClient` over
 * Streamable HTTP per enabled integration, its `tools/list` registered as deferred tools. Boot is the only moment this
 * happens, because the tool list is prompt prefix: a surface that changed when a server reconnected would re-price the
 * prefix mid-conversation, and one that changed when a container restarted would change what the model can do between
 * two messages of one turn. So the connection is made here, once, and the tools live with the process.
 *
 * Every MCP tool is `deferred`. A server may offer forty tools with schemas nobody needs this turn; declaring them all
 * would spend the context the deferred list exists to save, and `tool_search` is what promotes one on demand. That also
 * keeps two boots of the same build byte-identical in what the model is offered.
 *
 * Nothing here is fatal by default. A container that is down removes its tools, says so in one line and in
 * `/api/integrations`, and the boot carries on: an always-on agent that refuses to start because a documentation server
 * is redeploying is worse than one without that server. `"required": true` is the operator's opt-in to the other
 * behaviour, for the one integration the team cannot work without.
 *
 * Results are mapped with `toLlmContent`, so text and images pass through and audio, resource links and binary
 * resources become a short placeholder. A declared call's output is bounded to ~20 KB by the harness; stage B2 decides
 * how a code-mode script gets the whole result, because the harness applies those limits to a nested result too.
 */
import { createHash } from "node:crypto";
import {
	McpClient,
	type McpTransport,
	StreamableHttpTransport,
	type Tool as McpTool,
	toLlmContent,
} from "@earendil-works/pi-mcp";
import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type, type TUnsafe } from "typebox";
import { integrationStatus, type Integration } from "./integrations.ts";

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`; the name is also the identifier a script calls. */
const MAX_TOOL_NAME_LENGTH = 64;
/**
 * One request to an integration. Boot waits for every integration at once, so this is boot's bound too: a container
 * that accepts a socket and then says nothing must not hold the process indefinitely.
 */
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * What one declared call returns. A 200 KB tool result is context nobody asked for, and the model can be given the
 * same capability in pieces; the full result stays reachable in stage B2 through code mode.
 */
const OUTPUT_MAX_BYTES = 20_000;
/** Who the server sees on the wire. Not a credential: this slice has none (the network is the boundary). */
const CLIENT_NAME = "mason";
const CLIENT_VERSION = "0.1.0";

/** How the boot reaches one integration's endpoint. */
export type McpTransportFactory = (url: string) => McpTransport;

export interface ConnectIntegrationsOptions {
	readonly integrations: Record<string, Integration>;
	/**
	 * Opens a client's transport. Production builds one over Streamable HTTP at the url in
	 * `service/integrations.json`; a test hands in one end of `createInMemoryTransportPair()`, so no test dials a port.
	 */
	readonly openTransport?: McpTransportFactory;
	/** Where the boot's one line per integration goes. Defaults to the console. */
	readonly log?: (line: string) => void;
}

/** What the boot got, and the extension that carries it. */
export interface McpTools {
	/**
	 * The extension to install. `undefined` when no enabled integration has a tools face: nothing is installed then, so a
	 * build with no integration has exactly the surface it had before MCP existed, not an empty extension in the list.
	 */
	readonly extension: Extension | undefined;
	/** Every tool registered, in declaration order. */
	readonly tools: readonly ToolRegistration[];
}

/**
 * `mcp__<integration>__<tool>`, sanitized and shortened with a hash suffix when too long. Everything outside
 * `[A-Za-z0-9_]` becomes `_`, so an integration named `my-docs` and a tool named `issues.list` still make a name a
 * script can call and a provider accepts. Sanitizing can map two tools to one name (`a-b` and `a_b`); `isTaken` reports
 * names another tool already has, and those get the suffix instead.
 */
export function createMcpToolName(
	integration: string,
	tool: string,
	isTaken: (name: string) => boolean = () => false,
): string {
	const name = `mcp__${integration}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
	const hash = createHash("sha256").update(`${integration}\0${tool}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/**
 * MCP tools carry JSON Schema, pi tools carry TypeBox. `Type.Unsafe` carries the server's schema as it is: the marker it
 * adds is not a TypeBox kind, so pi-ai validates the arguments against the JSON Schema instead of compiling them as one.
 * The alternative is a cast, which is the same thing with the type system told to stop looking.
 *
 * A tool's input schema must be an object, and some providers reject an object schema without `properties`, so both are
 * filled in when a server omits them.
 */
function toParameters(schema: Record<string, unknown>): TUnsafe<Record<string, unknown>> {
	return Type.Unsafe<Record<string, unknown>>({
		...schema,
		type: schema.type ?? "object",
		...(schema.properties === undefined ? { properties: {} } : {}),
	});
}

/** One MCP tool as a deferred pi tool: the model's call goes to the server, and the server's answer to the model. */
function createMcpTool(integration: string, client: McpClient, tool: McpTool, name: string): ToolRegistration {
	return defineTool({
		name,
		// The server's own words, because they are what tool_search ranks and what the model reads before calling.
		description: tool.description?.trim() || tool.name,
		parameters: toParameters(tool.inputSchema),
		// Not offered until tool_search loads it. Every MCP tool is deferred, without a per-tool policy: the list of a
		// server is not a thing an operator should have to curate to keep the prefix small.
		deferred: true,
		// The declared call is bounded here. Stage B2 must decide how a code-mode script gets the full result: the harness
		// applies these limits to a nested result as well, so a script calling this tool would see the same 20 KB.
		outputLimits: { maxBytes: OUTPUT_MAX_BYTES },
		// Unsafe, pi's default, stated because it matters: a call interrupted by a restart settles as interrupted rather
		// than reaching a server twice. An MCP tool may create an issue; a rerun would create it twice.
		replay: "unsafe",
		async execute(args) {
			const result = await client.callTool(tool.name, args, { timeoutMs: REQUEST_TIMEOUT_MS });
			const content = toLlmContent(result);
			// An MCP error is an error result, so the model weighs it as a failure rather than as content. A server that
			// returns none of its own text gets one, because an empty error result says nothing about what went wrong.
			if (result.isError === true && !content.some((item) => item.type === "text" && item.text !== "")) {
				content.push({ type: "text", text: `MCP tool ${integration}/${tool.name} returned an error` });
			}
			return { output: content, ...(result.isError === true ? { isError: true } : {}) };
		},
	});
}

/** What one integration's attempt came to: its client and tools, or why there is none. */
type Reach =
	| {
			readonly name: string;
			readonly required: boolean;
			readonly client: McpClient;
			readonly listed: readonly McpTool[];
		}
	| { readonly name: string; readonly required: boolean; readonly error: string };

/**
 * Reach every enabled integration that has a tools face, in parallel, and turn what they offer into deferred tools.
 *
 * The tools are registered in integration-name order, after every attempt has settled, so a name collision is resolved
 * the same way on every boot whatever order the servers answered in.
 */
export async function connectIntegrations(options: ConnectIntegrationsOptions): Promise<McpTools> {
	const wanted = Object.entries(options.integrations)
		.flatMap(([name, integration]) =>
			integration.enabled && integration.tools !== undefined ? [{ name, tools: integration.tools }] : [],
		)
		.sort((left, right) => (left.name < right.name ? -1 : 1));
	if (wanted.length === 0) return { extension: undefined, tools: [] };
	const log = options.log ?? ((line: string) => console.log(line));
	const openTransport = options.openTransport ?? httpTransport;
	// In parallel: twenty integrations must not mean twenty timeouts of boot latency.
	const reached: Reach[] = await Promise.all(
		wanted.map(async ({ name, tools }) => {
			const required = tools.required === true;
			try {
				const { client, listed } = await connect(name, tools.url, openTransport);
				return { name, required, client, listed };
			} catch (error) {
				return { name, required, error: errorMessage(error) };
			}
		}),
	);

	const registered: ToolRegistration[] = [];
	const taken = new Set<string>();
	const statuses = integrationStatus();
	let refused: { readonly name: string; readonly error: string } | undefined;
	for (const result of reached) {
		if ("error" in result) {
			// Server state, so `/api/integrations` answers truthfully without the log being read.
			statuses.set(result.name, { connected: false, tools: 0, error: result.error });
			log(`[mcp] ${result.name}: unreachable (${result.error}); its tools are absent from this boot`);
			if (result.required && refused === undefined) refused = { name: result.name, error: result.error };
			continue;
		}
		for (const tool of result.listed) {
			const name = createMcpToolName(result.name, tool.name, (candidate) => taken.has(candidate));
			taken.add(name);
			registered.push(createMcpTool(result.name, result.client, tool, name));
		}
		statuses.set(result.name, { connected: true, tools: result.listed.length, error: null });
		log(`[mcp] ${result.name}: connected, ${result.listed.length} tool${result.listed.length === 1 ? "" : "s"}`);
	}
	if (refused !== undefined) {
		throw new Error(
			`integration "${refused.name}" is required and could not be reached (${refused.error}): the boot refuses ` +
				"rather than run with fewer tools than the operator said it cannot work without",
		);
	}
	// The name is fixed and the tools are the boot's: a conversation selecting it gets exactly these, and a boot with no
	// integration installs nothing at all — the surface without MCP is the surface before it.
	return { extension: defineExtension({ name: "mcp", tools: registered }), tools: registered };
}

/** One client, connected, initialized and asked what it offers. It stays open for the tool calls that follow. */
async function connect(
	name: string,
	url: string,
	openTransport: McpTransportFactory,
): Promise<{ readonly client: McpClient; readonly listed: readonly McpTool[] }> {
	const client = new McpClient({
		name: CLIENT_NAME,
		version: CLIENT_VERSION,
		requestTimeoutMs: REQUEST_TIMEOUT_MS,
	});
	try {
		await client.connect(openTransport(url));
		return { client, listed: await client.listTools() };
	} catch (error) {
		await client.close().catch(() => {});
		throw new Error(`MCP integration "${name}" at ${url}: ${errorMessage(error)}`);
	}
}

function httpTransport(url: string): McpTransport {
	return new StreamableHttpTransport({ url });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
