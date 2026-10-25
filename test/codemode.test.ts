/**
 * Code mode: the second way the model reaches a tool it was not offered, and the one that reads a whole result.
 *
 * `tool_search` promotes a deferred tool into the declared list, which appends to the prompt prefix; a script calls the
 * same tool without declaring it and can hand the model only what matters. So the two facts worth pinning are that a
 * script really does reach an undeclared tool, and that the same server answer arrives whole at a script and bounded at
 * the model — one server, two callers, one result.
 *
 * Everything runs against a fake MCP server on an in-memory transport and the real QuickJS sandbox: the sandbox is the
 * thing under test, so it is never stubbed, and no test dials a port.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
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
import { MESSAGE_TOOL } from "../src/shared/contract.ts";
import { createCodemode } from "../src/server/extensions/codemode.ts";
import { housePaths } from "../src/server/house.ts";
import type { Integration } from "../src/server/integrations.ts";
import type { McpTransportFactory } from "../src/server/mcp.ts";
import { openAgentRuntime, type AgentRuntime, type ResolvedModel } from "../src/server/runtime.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-codemode-"));
	directories.add(directory);
	return directory;
}

const GITHUB: Integration = {
	enabled: true,
	description: "Issues and pull requests for the team's repositories",
	tools: { url: "http://mason-github:8082/mcp" },
};

const SEARCH_TOOL: McpTool = {
	name: "issues.search",
	description: "Search issues by text",
	inputSchema: { type: "object", properties: { query: { type: "string" } } },
};

/** The name the tool is registered under: what a script calls as `tools.mcp__github__issues_search`. */
const SEARCH_TOOL_NAME = "mcp__github__issues_search";

/** A script that calls the deferred tool and returns the server's own text, as a script would read it. */
const SEARCH_SCRIPT = `const result = await tools.${SEARCH_TOOL_NAME}({ query: "bug" }); return result.content[0].text;`;

interface FakeServer {
	readonly transport: McpTransport;
	/** Every `tools/call` the client made, in order. */
	readonly calls: { name: string; args: Record<string, unknown> }[];
}

/** A fake MCP server: it initializes, lists one tool, and answers `tools/call` with `answer`. */
async function fakeServer(answer: () => CallToolResult): Promise<FakeServer> {
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
				return { tools: [SEARCH_TOOL] };
			case "tools/call": {
				const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
				calls.push({ name: params.name ?? "", args: params.arguments ?? {} });
				return answer();
			}
			default:
				throw new McpError(JSON_RPC_ERROR_CODES.methodNotFound, `Method not found: ${request.method}`);
		}
	}
}

/** The client end of a transport, counting how often the runtime closed it. */
function watched(inner: McpTransport): { transport: McpTransport; closes: () => number } {
	let closes = 0;
	return {
		transport: {
			start: () => inner.start(),
			send: (message, options) => inner.send(message, options),
			close: async () => {
				closes += 1;
				await inner.close();
			},
			onMessage: (listener) => inner.onMessage(listener),
			onError: (listener) => inner.onError(listener),
			onClose: (listener) => inner.onClose(listener),
		},
		closes: () => closes,
	};
}

function fauxAccess(steps: readonly FauxResponseStep[]): ResolvedModel {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([...steps]);
	return { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true };
}

interface BootOptions {
	readonly integrations?: Record<string, Integration>;
	readonly transport?: McpTransportFactory;
	readonly steps?: readonly FauxResponseStep[];
}

/** A boot of the real runtime over a temporary home, with a scripted model and an injected way to the server. */
async function boot(directory: string, options: BootOptions = {}): Promise<AgentRuntime> {
	if (options.integrations !== undefined) {
		const paths = housePaths(join(directory, "house"));
		await mkdir(dirname(paths.integrations), { recursive: true, mode: 0o700 });
		await writeFile(paths.integrations, JSON.stringify({ integrations: options.integrations }), { mode: 0o600 });
	}
	return openAgentRuntime(BACKGROUND_CONTEXT, {
		dataDir: join(directory, "data"),
		workspaceDir: directory,
		houseHome: join(directory, "house"),
		storage: "memory",
		modelAccess: fauxAccess(options.steps ?? []),
		...(options.transport === undefined ? {} : { mcpTransport: options.transport }),
		onReport: () => {},
	});
}

/** The names of the tools the model is offered: the list the prompt prefix pays for. */
async function declared(runtime: AgentRuntime): Promise<string[]> {
	const agent = await (await runtime.conversation()).agent(BACKGROUND_CONTEXT);
	return agent.tools.map((tool) => tool.name);
}

/** Runs the scripted turn to its end. */
async function turn(runtime: AgentRuntime): Promise<void> {
	const submission = await (await runtime.conversation()).submit({ type: "input", content: "Anything new?" }, BACKGROUND_CONTEXT);
	await submission.wait(BACKGROUND_CONTEXT);
}

/** What each tool result told the model, by tool name. */
async function toolResults(runtime: AgentRuntime): Promise<{ name: string; isError: boolean; text: string }[]> {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 1000, undefined, BACKGROUND_CONTEXT);
	return page.items.flatMap((entry) => {
		const message = entry.kind === "pi.tool-result" ? entry.model?.[0] : undefined;
		if (message?.role !== "toolResult") return [];
		return [
			{
				name: message.toolName,
				isError: message.isError,
				text: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
			},
		];
	});
}

/** The one result a tool produced in the turn. */
function resultOf(results: { name: string; text: string }[], name: string): string {
	const found = results.filter((result) => result.name === name);
	assert.equal(found.length, 1, `exactly one ${name} result`);
	return found[0]!.text;
}

/** The three steps every scripted turn ends with: the script, one message to the reader, and the model stopping. */
function scriptThenSpeak(code: string): FauxResponseStep[] {
	return [
		fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "script" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall(MESSAGE_TOOL, { message: "Done." }, { id: "sent" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(fauxText("Nothing else to report.")),
	];
}

describe("a script is the second way in", () => {
	it("calls a deferred tool the model was never offered, and the server's text comes back", async () => {
		const server = await fakeServer(() => ({ content: [{ type: "text", text: "ISSUE-412: search is slow" }] }));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			steps: scriptThenSpeak(SEARCH_SCRIPT),
		});
		try {
			assert.ok(!(await declared(runtime)).includes(SEARCH_TOOL_NAME), "the model was never offered this tool");
			await turn(runtime);
			const script = resultOf(await toolResults(runtime), "codemode");
			assert.match(script, /Script completed/);
			assert.match(script, /ISSUE-412: search is slow/, "the script read the server's own text");
			assert.deepEqual(
				server.calls,
				[{ name: "issues.search", args: { query: "bug" } }],
				"the script's arguments reached the server, and only they did",
			);
			assert.ok(
				!(await declared(runtime)).includes(SEARCH_TOOL_NAME),
				"reaching it from a script declared nothing: the prefix did not grow",
			);
		} finally {
			await runtime.close();
		}
	});

	it("gets the whole result while a model-issued call to the same tool is bounded", async () => {
		// Just past what a declared call may spend, with a marker at the very end: a bounded result loses the marker, and
		// a script that filtered nothing still has it.
		const answer = `${"x".repeat(23_900)}END-MARKER`;
		const server = await fakeServer(() => ({ content: [{ type: "text", text: answer }] }));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			steps: [
				// The same server, two callers: a script that hands the text back, then the model asking for the tool
				// through tool_search and calling it itself.
				...scriptThenSpeak(SEARCH_SCRIPT).slice(0, 1),
				fauxAssistantMessage([fauxToolCall("tool_search", { query: "search issues by text" }, { id: "load" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxToolCall(SEARCH_TOOL_NAME, { query: "bug" }, { id: "search" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxToolCall(MESSAGE_TOOL, { message: "Found some." }, { id: "sent" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxText("Nothing else to report.")),
			],
		});
		try {
			await turn(runtime);
			const results = await toolResults(runtime);
			const script = resultOf(results, "codemode");
			const direct = resultOf(results, SEARCH_TOOL_NAME);

			assert.ok(script.length > 20_000, `the script's result is ${script.length} characters, not a bounded one`);
			assert.match(script, /END-MARKER/, "the script received the result whole");
			assert.ok(!direct.includes("END-MARKER"), "the model's call lost the end of the result");
			const kept = /^x*/.exec(direct)?.[0].length ?? 0;
			assert.ok(kept <= 20_000, `${kept} bytes of the server's text is more than the 20 KB a declared call may spend`);
			assert.match(direct, /Output truncated/);
			assert.deepEqual(
				server.calls.map((call) => call.name),
				["issues.search", "issues.search"],
				"one server, two callers, and the script's call came first",
			);
		} finally {
			await runtime.close();
		}
	});

	it("has no models: no model tools are registered, and a script that reaches for one fails", async () => {
		// The tool alone: `models: false` registers no classifier or image tool, so the declared list cannot grow with
		// them and a script has no `models` global to spend the owner's money on.
		const codemode = createCodemode();
		try {
			assert.deepEqual(
				codemode.extension.tools?.map((tool) => tool.name),
				["codemode"],
				"the extension carries the script tool and nothing else",
			);
		} finally {
			await codemode.close();
		}

		const server = await fakeServer(() => ({ content: [] }));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			steps: scriptThenSpeak(`return await models.classify({ model: "faux-1", context: "is this urgent?" });`),
		});
		try {
			await turn(runtime);
			const [script] = (await toolResults(runtime)).filter((result) => result.name === "codemode");
			assert.equal(script?.isError, true, "a script cannot reach a model");
			assert.match(script?.text ?? "", /models is not defined/);
		} finally {
			await runtime.close();
		}
	});
});

/** Threads this process runs, or `undefined` where the platform does not say: `/proc` is Linux. */
function threadCount(): number | undefined {
	try {
		return readdirSync("/proc/self/task").length;
	} catch {
		return undefined;
	}
}

/** Poll `ready` until it holds, so a thread the runtime asked to stop has the moment it needs to stop. */
async function until(ready: () => boolean): Promise<boolean> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (ready()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return ready();
}

describe("the runtime's life", () => {
	it("closing it closes the MCP clients and the sandbox, and leaves no worker thread behind", async () => {
		const server = await fakeServer(() => ({ content: [{ type: "text", text: "ok" }] }));
		const transport = watched(server.transport);
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => transport.transport,
			steps: scriptThenSpeak(SEARCH_SCRIPT),
		});
		await turn(runtime);
		// After the turn, so the thread pool is warm and the count is the process's own: what changes is the worker a
		// script runs in, and closing must not leave one of those behind.
		const threads = threadCount();
		await runtime.close();
		assert.equal(transport.closes(), 1, "the client's socket closed with the runtime, once");
		if (threads !== undefined) {
			assert.ok(
				await until(() => (threadCount() ?? threads) <= threads),
				`${threadCount()} threads are running, where the process had ${threads} before it closed`,
			);
		}
	});

	it("two runtimes in sequence both run scripts, because the sandbox belongs to the boot", async () => {
		// A sandbox is permanent once closed, so a shared instance would refuse the second boot's scripts: this is the
		// regression a module-level `new CodemodeSandbox()` would have caused, in the one shape the suite does constantly.
		const directory = await temporaryDirectory();
		for (const round of [1, 2]) {
			const runtime = await boot(directory, { steps: scriptThenSpeak("return 6 * 7;") });
			try {
				await turn(runtime);
				const script = resultOf(await toolResults(runtime), "codemode");
				assert.match(script, /Script completed/, `round ${round} ran its script`);
				assert.match(script, /42/, "and the script's own value came back");
			} finally {
				await runtime.close();
			}
		}
	});
});
