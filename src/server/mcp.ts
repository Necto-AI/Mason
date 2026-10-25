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
 * resources become a short placeholder. Two callers read a result differently, and the harness makes that a declaration
 * rather than a special case: `output` is what the model is shown and is bounded to 20 KB, while `structuredOutput` is
 * what a program receives and is not bounded at all. So every MCP tool declares `structuredOutputSchema` and returns the
 * server's own result there — a code-mode script gets all 200 KB of a page and decides what the model needs to hear.
 */
import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import {
	type CallToolResult,
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
 * same capability in pieces; a code-mode script, which can filter before the model reads anything, gets it all.
 */
const OUTPUT_MAX_BYTES = 20_000;
/**
 * One block of the server's own `content`, as the coding agent declares it: a compact type carrying the fields text and
 * image blocks have, `additionalProperties` so a block the protocol adds later still passes. Scripts read
 * `content[0].text` and hand an image block to `image()` as it is.
 */
const CONTENT_BLOCK_SCHEMA = {
	type: "object",
	properties: {
		type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
		text: { type: "string" },
		data: { type: "string" },
		mimeType: { type: "string" },
	},
	required: ["type"],
	additionalProperties: true,
};
/**
 * What a script receives from an MCP tool: the server's result without `_meta`, untruncated — the `CallToolResult` as
 * the coding agent declares it, so a script here and a script in the coding agent read the same thing. `structuredContent`
 * is left open because a server may send any JSON value, with or without declaring a schema for it.
 *
 * A plain JSON Schema in `Type.Unsafe` rather than a `Type.Object`, like the server's input schema below: the harness
 * validates `structuredOutput` against it with a JSON Schema check, so it is carried as the server's protocol shapes it,
 * not compiled into TypeBox's own kinds.
 */
const MCP_RESULT_SCHEMA = Type.Unsafe<JsonValue>({
	type: "object",
	properties: {
		content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
		structuredContent: {},
		isError: { type: "boolean" },
	},
	required: ["content", "isError"],
	additionalProperties: true,
});
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
	/**
	 * Closes every client this boot opened. The tools hold their client, and a client holds a socket, so a runtime that
	 * closed without this would leave one connection per integration behind for the life of the process.
	 */
	close(): Promise<void>;
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
		// The split between the two callers, which the harness applies by itself: it bounds `output` and leaves
		// `structuredOutput` as it is, so a model-issued call spends at most 20 KB and a script gets the whole result.
		outputLimits: { maxBytes: OUTPUT_MAX_BYTES },
		structuredOutputSchema: MCP_RESULT_SCHEMA,
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
			return {
				output: content,
				structuredOutput: scriptResult(result),
				...(result.isError === true ? { isError: true } : {}),
			};
		},
	});
}

/**
 * The server's result as a program reads it: its own content blocks, its structured content, and whether it failed.
 *
 * The blocks are the server's, not `toLlmContent`'s: a script can decide about an audio block or a resource link, and
 * the model's view has already flattened those into a placeholder. `_meta` is dropped as the coding agent drops it: it
 * is transport bookkeeping, and a script that wanted it could not act on it anyway.
 */
function scriptResult(result: CallToolResult): JsonValue {
	return jsonCopy({
		content: result.content,
		...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
		isError: result.isError === true,
	});
}

/**
 * `value` as the JSON it already is. The result came off the wire parsed by pi-mcp and is about to be stored in the
 * call's document, which serializes it anyway; the round trip is what turns MCP's own block interfaces into the plain
 * JSON `JsonValue` names, and it also stops a script's value from aliasing the client's objects.
 */
function jsonCopy(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
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
	if (wanted.length === 0) return { extension: undefined, tools: [], close: async () => {} };
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
	const clients = reached.flatMap((result) => ("client" in result ? [result.client] : []));
	const close = async () => {
		// One client refusing to close must not keep the others open, and there is nothing to report: the process is
		// shutting down, and a half-closed socket dies with it.
		await Promise.all(clients.map((client) => client.close().catch(() => {})));
	};
	if (refused !== undefined) {
		// The clients that did connect have nobody left to serve: the boot refuses, so they close with it.
		await close();
		throw new Error(
			`integration "${refused.name}" is required and could not be reached (${refused.error}): the boot refuses ` +
				"rather than run with fewer tools than the operator said it cannot work without",
		);
	}
	// The name is fixed and the tools are the boot's: a conversation selecting it gets exactly these, and a boot with no
	// integration installs nothing at all — the surface without MCP is the surface before it.
	return { extension: defineExtension({ name: "mcp", tools: registered }), tools: registered, close };
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
