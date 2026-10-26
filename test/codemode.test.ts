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
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { McpTransport } from "@earendil-works/pi-mcp";
import { MESSAGE_TOOL } from "../src/shared/contract.ts";
import { createCodemode } from "../src/server/extensions/codemode.ts";
import {
	boot,
	declared,
	fakeServer,
	GITHUB,
	resultFor,
	SEARCH_SCRIPT,
	SEARCH_TOOL,
	SEARCH_TOOL_NAME,
	scriptThenSpeak,
	temporaryDirectory,
	toolResults,
	turn,
} from "./support/mcp.ts";

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

describe("a script is the second way in", () => {
	it("calls a deferred tool the model was never offered, and the server's text comes back", async () => {
		const server = await fakeServer([SEARCH_TOOL], () => ({ content: [{ type: "text", text: "ISSUE-412: search is slow" }] }));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			steps: scriptThenSpeak(SEARCH_SCRIPT),
		});
		try {
			assert.ok(!(await declared(runtime)).includes(SEARCH_TOOL_NAME), "the model was never offered this tool");
			await turn(runtime);
			const script = resultFor(await toolResults(runtime), "codemode");
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

	it("gets the whole result, both ends and all, while a model-issued call to the same tool is bounded by the middle", async () => {
		// A result past what a declared call may show, with a marker at each end: the model keeps both ends and loses the
		// middle, and a script that filtered nothing still has every byte.
		const answer = `START-MARKER${"x".repeat(30_000)}END-MARKER`;
		const server = await fakeServer([SEARCH_TOOL], () => ({ content: [{ type: "text", text: answer }] }));
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
			const script = resultFor(results, "codemode");
			const direct = resultFor(results, SEARCH_TOOL_NAME);

			// The script's own text, which the sandbox hands back whole: the bound is on what the model is shown, not on
			// what a program receives as `structuredOutput`.
			assert.ok(script.includes(answer), `the script's result carries all ${answer.length} characters`);
			assert.match(direct, /^START-MARKER/, "the model kept the beginning");
			assert.match(direct, /END-MARKER$/, "and the end, which head-only truncation would have dropped");
			assert.match(direct, /bytes dropped: this is the start and the end of a longer result/, "and is told what went");
			// Each end is about half the cap, so no run longer than that can be contiguous: the middle is what went.
			assert.ok(!direct.includes("x".repeat(11_000)), "the middle is what went");
			assert.ok(Buffer.byteLength(direct) <= 20 * 1024, `${Buffer.byteLength(direct)} bytes is more than the 20 KB cap`);
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

		const server = await fakeServer([SEARCH_TOOL], () => ({ content: [] }));
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
		const server = await fakeServer([SEARCH_TOOL], () => ({ content: [{ type: "text", text: "ok" }] }));
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
				const script = resultFor(await toolResults(runtime), "codemode");
				assert.match(script, /Script completed/, `round ${round} ran its script`);
				assert.match(script, /42/, "and the script's own value came back");
			} finally {
				await runtime.close();
			}
		}
	});
});
