/**
 * An integration's tools: reached once at boot, registered as deferred, and reached by the model only through
 * `tool_search`.
 *
 * Everything here runs against a fake MCP server on an in-memory transport, injected through the boot's
 * `mcpTransport` seam: no test dials a port, so a test can describe a server that offers two tools or one that is
 * down without a container existing.
 *
 * The two facts worth pinning are the ones a person cannot see from the code: that a connected integration does not
 * change what the model is offered (the deferred list is the whole point), and that the tools are still reachable
 * once asked for (a deferred tool nobody can load is a tool that does not exist).
 */
import assert from "node:assert/strict";
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
	type Tool as McpTool,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import { MESSAGE_TOOL } from "../src/shared/contract.ts";
import { housePaths } from "../src/server/house.ts";
import { integrationStatus } from "../src/server/integration-status.ts";
import type { Integration } from "../src/server/integrations.ts";
import { connectIntegrations, createMcpToolName, type McpTransportFactory } from "../src/server/mcp.ts";
import { startServer } from "../src/server/main.ts";
import { openAgentRuntime, type AgentRuntime, type ResolvedModel } from "../src/server/runtime.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-mcp-"));
	directories.add(directory);
	return directory;
}

const GITHUB: Integration = {
	enabled: true,
	description: "Issues and pull requests for the team's repositories",
	tools: { url: "http://mason-github:8082/mcp" },
};

/** The same server, marked as the one the team cannot work without. */
const REQUIRED_GITHUB: Integration = { ...GITHUB, tools: { url: "http://mason-github:8082/mcp", required: true } };

const ISSUE_TOOL: McpTool = {
	name: "issues.create",
	description: "Open an issue in a repository",
	inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
};

const SEARCH_TOOL: McpTool = {
	name: "issues.search",
	description: "Search issues by text",
	inputSchema: { type: "object", properties: { query: { type: "string" } } },
};

/** The declared name of `SEARCH_TOOL` on `github`: what a test asks `tool_search` to find. */
const SEARCH_TOOL_NAME = "mcp__github__issues_search";

interface FakeServer {
	/** The client end of the pair: what the boot's transport factory hands back. */
	readonly transport: InMemoryTransport;
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
async function fakeServer(
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
function downTransport(): never {
	throw new Error("no container in a test");
}

/** The schema as a provider reads it: the declared object, not the marker `Type.Unsafe` keeps out of the JSON. */
function schemaOf(parameters: unknown): Record<string, unknown> {
	return JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>;
}

function fauxAccess(steps: readonly FauxResponseStep[]): { access: ResolvedModel; faux: ReturnType<typeof fauxProvider> } {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([...steps]);
	return { access: { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true }, faux };
}

interface BootOptions {
	readonly integrations?: Record<string, Integration>;
	readonly transport?: McpTransportFactory;
	readonly steps?: readonly FauxResponseStep[];
	/** Keep the conversation on disk, so a second boot is a restart of the same agent rather than a new one. */
	readonly persist?: boolean;
}

/** A boot of the real runtime over a temporary home, with a scripted model and an injected way to reach the servers. */
async function boot(
	directory: string,
	options: BootOptions = {},
): Promise<{ runtime: AgentRuntime; faux: ReturnType<typeof fauxProvider> }> {
	if (options.integrations !== undefined) {
		const paths = housePaths(join(directory, "house"));
		await mkdir(dirname(paths.integrations), { recursive: true, mode: 0o700 });
		await writeFile(paths.integrations, JSON.stringify({ integrations: options.integrations }), { mode: 0o600 });
	}
	const { access, faux } = fauxAccess(options.steps ?? []);
	const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
		dataDir: join(directory, "data"),
		workspaceDir: directory,
		houseHome: join(directory, "house"),
		...(options.persist === true ? {} : { storage: "memory" as const }),
		modelAccess: access,
		...(options.transport === undefined ? {} : { mcpTransport: options.transport }),
		onReport: () => {},
	});
	return { runtime, faux };
}

/** The names of the tools the model is offered, which is the list the prompt prefix pays for. */
async function declared(runtime: AgentRuntime): Promise<string[]> {
	const agent = await (await runtime.conversation()).agent(BACKGROUND_CONTEXT);
	return agent.tools.map((tool) => tool.name);
}

/** The names the model can load with `tool_search`: deferred tools, offered to nobody yet. */
async function deferred(runtime: AgentRuntime): Promise<string[]> {
	const agent = await (await runtime.conversation()).agent(BACKGROUND_CONTEXT);
	return agent.deferred.map((tool) => tool.name);
}

/** Runs the scripted turn to its end. */
async function turn(runtime: AgentRuntime, content = "Anything new?"): Promise<void> {
	const submission = await (await runtime.conversation()).submit({ type: "input", content }, BACKGROUND_CONTEXT);
	await submission.wait(BACKGROUND_CONTEXT);
}

/** What the model was told by each tool result: committed entries, which the projection then drops as not the reader's. */
async function toolResults(runtime: AgentRuntime): Promise<{ name: string; isError: boolean; text: string }[]> {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 1000, undefined, BACKGROUND_CONTEXT);
	return page.items.flatMap((entry) => {
		const message = entry.kind === "pi.tool-result" ? entry.model?.[0] : undefined;
		if (message?.role !== "toolResult") return [];
		const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		return [{ name: message.toolName, isError: message.isError, text }];
	});
}

describe("what a server offers", () => {
	it("registers each tool as mcp__<integration>__<tool>, with the server's description and schema", async () => {
		const server = await fakeServer([ISSUE_TOOL, SEARCH_TOOL], () => ({ content: [] }));
		const mcp = await connectIntegrations({
			integrations: { github: GITHUB },
			openTransport: () => server.transport,
			log: () => {},
		});
		assert.deepEqual(
			mcp.tools.map((tool) => tool.name),
			["mcp__github__issues_create", SEARCH_TOOL_NAME],
			"the integration's name and the tool's, with dots made into underscores",
		);
		const [create] = mcp.tools;
		assert.equal(create.description, "Open an issue in a repository", "the server's own words, because the model reads them");
		// An MCP tool's schema is JSON Schema, declared as it arrived: a property the server named is the property the
		// model is asked for, and an object schema without `properties` is rejected by some providers, so both stand.
		assert.deepEqual(schemaOf(create.parameters), {
			type: "object",
			properties: { title: { type: "string" } },
			required: ["title"],
		});
		assert.equal(create.deferred, true, "deferred is what keeps a server's forty schemas out of the prefix");
		assert.equal(mcp.extension?.name, "mcp");
		assert.deepEqual(integrationStatus().get("github"), { connected: true, tools: 2, error: null });
	});

	it("fills in the object shape a server may leave out", async () => {
		const bare: McpTool = { name: "ping", inputSchema: {} };
		const server = await fakeServer([bare], () => ({ content: [] }));
		const mcp = await connectIntegrations({
			integrations: { github: GITHUB },
			openTransport: () => server.transport,
			log: () => {},
		});
		assert.deepEqual(schemaOf(mcp.tools[0].parameters), { type: "object", properties: {} });
		// No description on the server: the name is the only true thing left to say about it.
		assert.equal(mcp.tools[0].description, "ping");
	});
});

describe("the name a tool is registered under", () => {
	it("turns everything outside [A-Za-z0-9_] into _, so a script can call it too", () => {
		assert.equal(createMcpToolName("my-docs", "issues.list"), "mcp__my_docs__issues_list");
		assert.equal(createMcpToolName("github", "a.b-c d"), "mcp__github__a_b_c_d");
	});

	it("keeps a name within 64 characters, ending it with 8 hex digits of its own", () => {
		const long = createMcpToolName("github", "x".repeat(80));
		assert.equal(long.length, 64);
		assert.match(long, /^mcp__github__x+_[0-9a-f]{8}$/, "the suffix is the name's hash, so it is the same on every boot");
		assert.equal(long, createMcpToolName("github", "x".repeat(80)), "two boots agree about the name");
	});

	it("gives two tools that sanitize to one name distinct names, rather than one tool", async () => {
		const dash = createMcpToolName("github", "a-b");
		assert.equal(dash, "mcp__github__a_b");
		const suffixed = createMcpToolName("github", "a_b", (name) => name === dash);
		assert.notEqual(suffixed, dash);
		assert.match(suffixed, /_[0-9a-f]{8}$/);

		// The same through the registry, which is where it matters: a collision would silently drop a tool.
		const server = await fakeServer(
			[
				{ name: "a-b", inputSchema: { type: "object", properties: {} } },
				{ name: "a_b", inputSchema: { type: "object", properties: {} } },
			],
			() => ({ content: [] }),
		);
		const mcp = await connectIntegrations({
			integrations: { github: GITHUB },
			openTransport: () => server.transport,
			log: () => {},
		});
		const names = mcp.tools.map((tool) => tool.name);
		assert.equal(new Set(names).size, 2, "both tools exist");
		assert.deepEqual(names[0], "mcp__github__a_b");
	});
});

describe("the boot", () => {
	it("connects nothing when no integration has a tools face, so the surface is the one before MCP", async () => {
		const directory = await temporaryDirectory();
		const mcp = await connectIntegrations({ integrations: { github: { enabled: true } }, log: () => {} });
		assert.deepEqual(mcp.tools, []);
		assert.equal(mcp.extension, undefined, "nothing to reach means nothing installed, not an empty extension");
		const { runtime } = await boot(directory);
		try {
			assert.ok(!(await declared(runtime)).some((name) => name.startsWith("mcp__")));
			assert.ok(!(await deferred(runtime)).some((name) => name.startsWith("mcp__")));
		} finally {
			await runtime.close();
		}
	});

	it("counts an integration without a tools face as nothing to connect, and a disabled one as not its business", async () => {
		const mcp = await connectIntegrations({
			integrations: {
				activity: { enabled: true, trigger: { hook: "github-activity", secret: "s".repeat(32) } },
				docs: { enabled: false, description: "Docs", tools: { url: "http://mason-docs:8080/mcp" } },
			},
			openTransport: downTransport,
			log: () => {},
		});
		assert.deepEqual(mcp.tools, [], "a disabled integration is not attempted at all");
		assert.equal(integrationStatus().size, 0, "nothing was tried, so nothing has health");
	});

	it("logs one line about an unreachable optional integration, records it, and goes on without its tools", async () => {
		const lines: string[] = [];
		const mcp = await connectIntegrations({
			integrations: { github: GITHUB },
			openTransport: downTransport,
			log: (line) => lines.push(line),
		});
		assert.deepEqual(mcp.tools, []);
		assert.equal(lines.length, 1);
		assert.match(lines[0], /github/);
		assert.match(lines[0], /no container in a test/);
		assert.deepEqual(integrationStatus().get("github"), {
			connected: false,
			tools: 0,
			error: 'MCP integration "github" at http://mason-github:8082/mcp: no container in a test',
		});

		// The same through the real boot: it starts, and the tools a person configured are simply absent.
		const directory = await temporaryDirectory();
		const { runtime } = await boot(directory, { integrations: { github: GITHUB }, transport: downTransport });
		try {
			assert.ok(!(await declared(runtime)).some((name) => name.startsWith("mcp__")));
			assert.equal(integrationStatus().get("github")?.connected, false);
		} finally {
			await runtime.close();
		}
	});

	it("refuses the boot for an integration whose config says it is required, naming it", async () => {
		const directory = await temporaryDirectory();
		await assert.rejects(
			() => boot(directory, { integrations: { github: REQUIRED_GITHUB }, transport: downTransport }),
			(error: Error) => /integration "github" is required/.test(error.message),
			"an operator who said the team cannot work without it gets a refusal, not a quiet loss",
		);
	});

	it("offers the same tools with an integration connected as without one", async () => {
		const server = await fakeServer([ISSUE_TOOL, SEARCH_TOOL], () => ({ content: [] }));
		const connectedDirectory = await temporaryDirectory();
		const bareDirectory = await temporaryDirectory();
		const connected = await boot(connectedDirectory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
		});
		const bare = await boot(bareDirectory);
		try {
			assert.deepEqual(await declared(connected.runtime), await declared(bare.runtime), "a connected server costs no prefix");
			// Code mode is in both lists: it is installed at boot whatever any integration offers, so the surface moves once,
			// in the commit that added it, and never when a container appears.
			assert.ok((await declared(connected.runtime)).includes("codemode"), "code mode is offered either way");
			assert.ok((await declared(bare.runtime)).includes("codemode"));
			assert.deepEqual(await deferred(connected.runtime), ["mcp__github__issues_create", SEARCH_TOOL_NAME]);
			assert.deepEqual(await deferred(bare.runtime), []);
		} finally {
			await connected.runtime.close();
			await bare.runtime.close();
		}
	});

	it("reaches an integration added since the last boot, without the tool list moving", async () => {
		const directory = await temporaryDirectory();
		// A home that booted before any integration existed: its stored extension selection is the array from that boot,
		// which knows nothing about `mcp`. An array is used verbatim, so nothing would bring the new tools back.
		const first = await boot(directory, { persist: true });
		const before = await declared(first.runtime);
		await first.runtime.close();

		const server = await fakeServer([ISSUE_TOOL, SEARCH_TOOL], () => ({ content: [] }));
		const second = await boot(directory, { integrations: { github: GITHUB }, transport: () => server.transport, persist: true });
		try {
			assert.deepEqual(
				await declared(second.runtime),
				before,
				"the selection was repaired, and what the model is offered did not move",
			);
			assert.ok((await deferred(second.runtime)).includes(SEARCH_TOOL_NAME), "an existing home gets the capability");
		} finally {
			await second.runtime.close();
		}
	});

	it("lets tool_search find a deferred tool by its description, and declares it on the next request", async () => {
		const server = await fakeServer([ISSUE_TOOL, SEARCH_TOOL], () => ({ content: [] }));
		const directory = await temporaryDirectory();
		const { runtime } = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			// The model asks for a capability it was not offered, then speaks. The second request is the one that must
			// carry the tool.
			steps: [
				fauxAssistantMessage([fauxToolCall("tool_search", { query: "search issues by text" }, { id: "load" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxToolCall(MESSAGE_TOOL, { message: "Search is ready." }, { id: "sent" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxText("Nothing else to report.")),
			],
		});
		try {
			assert.ok(!(await declared(runtime)).includes(SEARCH_TOOL_NAME), "not offered before it is asked for");
			await turn(runtime);
			assert.ok((await declared(runtime)).includes(SEARCH_TOOL_NAME), "loaded, and recorded on the branch");
			const [loaded] = (await toolResults(runtime)).filter((result) => result.name === "tool_search");
			assert.match(loaded.text, new RegExp(SEARCH_TOOL_NAME));
		} finally {
			await runtime.close();
		}
	});

	it("bounds what a declared call returns, so a 30 KB result is not 30 KB of context", async () => {
		const server = await fakeServer([SEARCH_TOOL], () => ({
			content: [{ type: "text", text: "x".repeat(30_000) }],
		}));
		const directory = await temporaryDirectory();
		const { runtime } = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			steps: [
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
			assert.deepEqual(server.calls, [{ name: "issues.search", args: { query: "bug" } }], "the model's arguments reach the server");
			const [result] = (await toolResults(runtime)).filter((entry) => entry.name === SEARCH_TOOL_NAME);
			// The server's own text, which is what the limit is about: the harness adds its own notice after it, and that
			// notice is short and says more than another 10 KB of the same character would.
			const kept = /^x*/.exec(result.text)?.[0].length ?? 0;
			assert.ok(kept <= 20_000, `${kept} bytes of the server's text is more than the 20 KB a declared call may spend`);
			assert.ok(kept > 19_000, "the head is kept: an empty answer would be as bad as a huge one");
			assert.ok(!result.text.includes("x".repeat(20_001)), "the rest did not land in the transcript");
			assert.match(result.text, /Output truncated/);
			assert.equal(result.isError, false);
		} finally {
			await runtime.close();
		}
	});
});

describe("the integrations route", () => {
	it("reports an integration connected with the number of tools it offered", async () => {
		const directory = await temporaryDirectory();
		const paths = housePaths(join(directory, "house"));
		await mkdir(dirname(paths.integrations), { recursive: true, mode: 0o700 });
		await writeFile(
			paths.integrations,
			JSON.stringify({ integrations: { github: GITHUB } }),
			{ mode: 0o600 },
		);
		const server = await fakeServer([ISSUE_TOOL, SEARCH_TOOL], () => ({ content: [] }));
		const mason = await startServer({
			port: 0,
			hostname: "127.0.0.1",
			storage: "memory",
			dataDir: join(directory, "data"),
			workspaceDir: join(directory, "workspace"),
			houseHome: paths.home,
			faux: true,
			onReport: () => {},
			mcpTransport: () => server.transport,
		});
		try {
			assert.ok(mason.pairingToken, "a fresh home mints one token, which is what pairs this test");
			const answer = await fetch(`http://127.0.0.1:${mason.port}/api/integrations`, {
				headers: { authorization: `Bearer ${mason.pairingToken}` },
			});
			assert.equal(answer.status, 200);
			const body = (await answer.json()) as { integrations: Record<string, unknown>[] };
			assert.deepEqual(body.integrations, [
				{ name: "github", enabled: true, hasTools: true, hasTrigger: false, connected: true, tools: 2, error: null },
			]);
		} finally {
			await mason.close();
		}
	});
});
