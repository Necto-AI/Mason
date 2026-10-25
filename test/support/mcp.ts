/**
 * The scaffolding the MCP tests share: a fake server on an in-memory transport, and a boot of the real runtime that
 * reaches it.
 *
 * `mcp.test.ts` and `codemode.test.ts` ask different questions about the same subject — one server, two callers — so
 * what they need before they can ask is identical: a server that speaks the protocol without a socket, a home with an
 * integration in it, and the committed tool results a scripted turn produced. That part lives here, once; the
 * assertions stay in each file, because they are what the two files are about.
 *
 * No test dials a port: the transport is injected through the boot's `mcpTransport` seam, so a server that offers two
 * tools, one tool, or nothing at all is a description rather than a container.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxResponseStep,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	type CallToolResult,
	JSON_RPC_ERROR_CODES,
	LATEST_PROTOCOL_VERSION,
	McpError,
	type JsonRpcMessage,
	type JsonRpcRequest,
	type McpTransport,
	type Tool as McpTool,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { MESSAGE_TOOL } from "../../src/shared/contract.ts";
import { housePaths } from "../../src/server/house.ts";
import type { Integration } from "../../src/server/integrations.ts";
import type { McpTransportFactory } from "../../src/server/mcp.ts";
import { openAgentRuntime, type AgentRuntime, type ResolvedModel } from "../../src/server/runtime.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

/** A directory that exists for this file's tests and is removed when the file is done. */
export async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-mcp-"));
	directories.add(directory);
	return directory;
}

/** An integration with a tools face: the ordinary shape of the thing under test. */
export const GITHUB: Integration = {
	enabled: true,
	description: "Issues and pull requests for the team's repositories",
	tools: { url: "http://mason-github:8082/mcp" },
};

/** The same server, marked as the one the team cannot work without. */
export const REQUIRED_GITHUB: Integration = {
	...GITHUB,
	tools: { url: "http://mason-github:8082/mcp", required: true },
};

export const ISSUE_TOOL: McpTool = {
	name: "issues.create",
	description: "Open an issue in a repository",
	inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
};

export const SEARCH_TOOL: McpTool = {
	name: "issues.search",
	description: "Search issues by text",
	inputSchema: { type: "object", properties: { query: { type: "string" } } },
};

/** The declared name of {@link SEARCH_TOOL} on `github`: what a test asks `tool_search` to find. */
export const SEARCH_TOOL_NAME = "mcp__github__issues_search";

export interface FakeServer {
	/** The client end of the pair: what the boot's transport factory hands back. */
	readonly transport: McpTransport;
	/** Every `tools/call` the client made, in order. */
	readonly calls: { name: string; args: Record<string, unknown> }[];
}

/** The `tools/call` parameters, as the fake server needs them. */
function callOf(params: unknown): { name: string; args: Record<string, unknown> } {
	const record = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
	const args = record.arguments;
	return {
		name: typeof record.name === "string" ? record.name : "",
		args: typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
	};
}

/**
 * A fake MCP server: it initializes, lists `tools`, and answers `tools/call` with `answer`. Statements arrive on one
 * end of an in-memory pair, so the client speaks the real protocol and never touches a socket.
 */
export async function fakeServer(
	tools: readonly McpTool[],
	answer: (name: string, args: Record<string, unknown>) => CallToolResult,
): Promise<FakeServer> {
	const pair = createInMemoryTransportPair();
	const calls: FakeServer["calls"] = [];
	pair.server.onMessage((message: JsonRpcMessage) => {
		if (!("id" in message) || !("method" in message)) return;
		const request: JsonRpcRequest = message;
		void (async () => {
			try {
				await pair.server.send({ jsonrpc: "2.0", id: request.id, result: resultOf(request) });
			} catch (error) {
				await pair.server.send({
					jsonrpc: "2.0",
					id: request.id,
					error: {
						code: JSON_RPC_ERROR_CODES.internalError,
						message: error instanceof Error ? error.message : String(error),
					},
				});
			}
		})();
	});
	await pair.server.start();
	return { transport: pair.client, calls };

	function resultOf(request: JsonRpcRequest): unknown {
		switch (request.method) {
			case "initialize":
				return {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "fake", version: "1.0.0" },
				};
			case "tools/list":
				return { tools };
			case "tools/call": {
				const { name, args } = callOf(request.params);
				calls.push({ name, args });
				return answer(name, args);
			}
			default:
				throw new McpError(JSON_RPC_ERROR_CODES.methodNotFound, `Method not found: ${request.method}`);
		}
	}
}

/** A boot that reaches for a server nobody is listening on: the container is down, so the factory refuses. */
export function downTransport(): never {
	throw new Error("no container in a test");
}

/** A scripted model: the steps it answers with, in order, played by the faux provider. */
export function fauxAccess(steps: readonly FauxResponseStep[]): ResolvedModel {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([...steps]);
	return { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true };
}

export interface BootOptions {
	readonly integrations?: Record<string, Integration>;
	readonly transport?: McpTransportFactory;
	readonly steps?: readonly FauxResponseStep[];
	/** Keep the conversation on disk, so a second boot is a restart of the same agent rather than a new one. */
	readonly persist?: boolean;
}

/** A boot of the real runtime over a temporary home, with a scripted model and an injected way to reach the servers. */
export async function boot(directory: string, options: BootOptions = {}): Promise<AgentRuntime> {
	if (options.integrations !== undefined) {
		const paths = housePaths(join(directory, "house"));
		await mkdir(dirname(paths.integrations), { recursive: true, mode: 0o700 });
		await writeFile(paths.integrations, JSON.stringify({ integrations: options.integrations }), { mode: 0o600 });
	}
	return openAgentRuntime(BACKGROUND_CONTEXT, {
		dataDir: join(directory, "data"),
		workspaceDir: directory,
		houseHome: join(directory, "house"),
		...(options.persist === true ? {} : { storage: "memory" as const }),
		modelAccess: fauxAccess(options.steps ?? []),
		...(options.transport === undefined ? {} : { mcpTransport: options.transport }),
		onReport: () => {},
	});
}

/** The names of the tools the model is offered, which is the list the prompt prefix pays for. */
export async function declared(runtime: AgentRuntime): Promise<string[]> {
	const agent = await (await runtime.conversation()).agent(BACKGROUND_CONTEXT);
	return agent.tools.map((tool) => tool.name);
}

/** The names the model can load with `tool_search`: deferred tools, offered to nobody yet. */
export async function deferred(runtime: AgentRuntime): Promise<string[]> {
	const agent = await (await runtime.conversation()).agent(BACKGROUND_CONTEXT);
	return agent.deferred.map((tool) => tool.name);
}

/** A script that calls the deferred search tool and returns the server's own text, as a script would read it. */
export const SEARCH_SCRIPT = `const result = await tools.${SEARCH_TOOL_NAME}({ query: "bug" }); return result.content[0].text;`;

/** Runs the scripted turn to its end. */
export async function turn(runtime: AgentRuntime, content = "Anything new?"): Promise<void> {
	const submission = await (await runtime.conversation()).submit({ type: "input", content }, BACKGROUND_CONTEXT);
	await submission.wait(BACKGROUND_CONTEXT);
}

/** What the model was told by each tool result: committed entries, which the projection then drops as not the reader's. */
export async function toolResults(runtime: AgentRuntime): Promise<{ name: string; isError: boolean; text: string }[]> {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 1000, undefined, BACKGROUND_CONTEXT);
	return page.items.flatMap((entry) => {
		const message = entry.kind === "pi.tool-result" ? entry.model?.[0] : undefined;
		if (message?.role !== "toolResult") return [];
		const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		return [{ name: message.toolName, isError: message.isError, text }];
	});
}

/** The one result a tool produced in the turn. */
export function resultFor(results: { name: string; isError: boolean; text: string }[], name: string): string {
	const found = results.filter((result) => result.name === name);
	assert.equal(found.length, 1, `exactly one ${name} result`);
	return found[0]!.text;
}

/** The three steps a scripted turn ends with: the model asks for the tool, listens to the script, then speaks. */
export function scriptThenSpeak(code: string): FauxResponseStep[] {
	return [
		fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "script" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall(MESSAGE_TOOL, { message: "Done." }, { id: "sent" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(fauxText("Nothing else to report.")),
	];
}
