/**
 * The permission gateway: one decision in front of every tool call, and the question a person answers when it says "ask".
 *
 * Three things are pinned here, and they are the three the design rests on. The **decision** is a pure function of the
 * call, the turn's origin and the operator's configuration, so the whole matrix of markers and rules is a table with no
 * runtime in it. The **question** is a transcript entry that a person settles, so no tool runs before the answer, a
 * denial comes back as a structured result, and `/stop` cancels the wait. And the **restart** is a crash rather than a
 * close: `restart-child.ts` dies while a call waits, and recovery must find the answer, run the approved call once and
 * repeat nothing it already did.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { SubmissionId } from "@earendil-works/pi-durable";
import type { Integration } from "../src/server/integrations.ts";
import {
	approverFor,
	decide,
	type HookCommitter,
	keepEarliest,
	type MarkerReading,
	mayAnswer,
	PERMISSION_ANSWER_ENTRY_KIND,
	type PermissionAnswer,
	PermissionBook,
	type PermissionInputs,
	type PermissionRequest,
	surfaceFor,
} from "../src/server/permissions.ts";
import { REPLY_TOOL } from "../src/shared/contract.ts";
import {
	boot,
	fakeServer,
	GITHUB,
	GUARDED_TOOL,
	MCP,
	SEARCH_SCRIPT,
	SEARCH_TOOL,
	SILENT_TOOL,
	scriptThenSpeak,
	TWO_CALLS,
	temporaryDirectory,
	turn,
} from "./support/mcp.ts";

/** A connector whose markers are not trusted: the default, and the reason a `not_required` tool still asks. */
const UNTRUSTED: Integration = { ...GITHUB, connector: { state: [], trustMarkers: false } };

/** The same server behind an operator who allowed one tool by name, without trusting the rest. */
const ALLOWS_SEARCH: Integration = {
	...GITHUB,
	connector: { state: [], trustMarkers: false, policy: { allow: ["issues.search"] } },
};

/** The same, for the effect tool the decision table's default arguments name. */
const ALLOWS_CREATE: Integration = {
	...GITHUB,
	connector: { state: [], trustMarkers: false, policy: { allow: ["issues.create"] } },
};

/**
 * The decision inputs, with the catalog's answer fixed by the test: `marker` is what the service said about the tool,
 * `"absent"` is a tool it no longer offers (or a service that is not answering), and absence of the option is the
 * `required` default.
 */
function inputs(
	options: {
		readonly toolName?: string;
		readonly args?: Record<string, unknown>;
		readonly marker?: "required" | "not_required" | "absent" | "unresolved";
		readonly integration?: Integration;
		readonly origin?: PermissionInputs["origin"];
	} = {},
): PermissionInputs {
	const marker = options.marker ?? "required";
	const reading: MarkerReading | undefined =
		marker === "unresolved"
			? undefined
			: marker === "absent"
				? { present: false, why: "the catalog cannot see github/issues.create right now" }
				: { present: true, marker };
	return {
		toolName: options.toolName ?? MCP.call,
		args: options.args ?? { integration: "github", tool: "issues.create", arguments: {} },
		origin: options.origin ?? { kind: "console" },
		integrations: { github: options.integration ?? GITHUB },
		...(reading === undefined ? {} : { reading }),
	};
}

describe("the decision", () => {
	it("refuses a call nobody can see: a tool that is gone, a service that is not answering, or no answer at all", () => {
		// The catalog's answer is resolved before the decision, so "absent" is a fact about now rather than about a cache.
		// Both refusals, because a `required` marker that a reconnect could hide is a call that runs unasked.
		for (const marker of ["absent", "unresolved"] as const) {
			const refused = decide(inputs({ marker }));
			assert.equal(refused.kind, "deny", marker);
			assert.match(refused.kind === "deny" ? refused.reason : "", /cannot see|no catalog answer/);
		}
	});

	it("asks for a required tool whatever the operator allowed, and never lets a marker loosen a rule", () => {
		assert.equal(decide(inputs({ marker: "required" })).kind, "ask");
		const allowed: Integration = {
			...GITHUB,
			connector: { state: [], trustMarkers: false, policy: { allow: ["issues.create"] } },
		};
		assert.equal(
			decide(inputs({ integration: allowed, marker: "required" })).kind,
			"ask",
			"the rule cannot waive it",
		);
	});

	it("allows a not_required tool only with trusted markers or a rule that names it", () => {
		assert.equal(decide(inputs({ integration: GITHUB, marker: "not_required" })).kind, "allow", "trusted markers");
		assert.equal(decide(inputs({ integration: UNTRUSTED, marker: "not_required" })).kind, "ask", "no trust, no rule");
		assert.equal(decide(inputs({ integration: ALLOWS_CREATE, marker: "not_required" })).kind, "allow", "the rule");
	});

	it("tightens with ask and deny, which beat a trusted marker and a wider rule", () => {
		const askRule: Integration = {
			...GITHUB,
			connector: { state: [], trustMarkers: true, policy: { ask: ["issues.create"] } },
		};
		assert.equal(decide(inputs({ integration: askRule, marker: "not_required" })).kind, "ask");
		const denyRule: Integration = {
			...GITHUB,
			connector: { state: [], trustMarkers: true, policy: { deny: ["issues.create"], allow: ["issues.create"] } },
		};
		assert.equal(decide(inputs({ integration: denyRule, marker: "not_required" })).kind, "deny");
		const everything: Integration = {
			...GITHUB,
			connector: { state: [], trustMarkers: true, policy: { deny: ["*"] } },
		};
		assert.equal(decide(inputs({ integration: everything, marker: "required" })).kind, "deny", "`*` is every tool");
	});

	it("allows a reply to a fire's own carried conversation, which is a turn's origin too", () => {
		// A fire may carry the origin a reply would go to. Keeping that voice where it was is the same decision as keeping
		// a person's words where they were, and asking would be a question with no surface to answer it on.
		const fired = inputs({
			toolName: "reply",
			args: { text: "done", to: { connector: "telegram", conversation: "-1001234" } },
			origin: { kind: "hook", origin: { connector: "telegram", externalConversationId: "-1001234" } },
		});
		assert.equal(decide(fired).kind, "allow");
	});

	it("allows a reply to the turn's own origin and asks for one addressed elsewhere", () => {
		const carried = {
			kind: "connector" as const,
			origin: { connector: "telegram", externalConversationId: "-1001234", externalActorId: "8811" },
		};
		assert.equal(
			decide(
				inputs({
					toolName: REPLY_TOOL,
					args: { message: "hi", to: { connector: "telegram", conversation: "-1001234" } },
					origin: carried,
				}),
			).kind,
			"allow",
			"answering whoever spoke is what the tool is for",
		);
		assert.equal(
			decide(
				inputs({
					toolName: REPLY_TOOL,
					args: { message: "hi", to: { connector: "telegram", conversation: "8811" } },
					origin: carried,
				}),
			).kind,
			"ask",
			"sending somewhere else is a person's decision",
		);
		assert.equal(decide(inputs({ toolName: REPLY_TOOL, args: { message: "hi" }, origin: carried })).kind, "allow");
	});

	it("allows mason's own tools: the gate is in front of them, and it has no question to ask about bash", () => {
		for (const toolName of ["bash", "read", "write", "edit", "codemode", "tool_search", MCP.search, MCP.describe]) {
			assert.equal(decide(inputs({ toolName, args: {} })).kind, "allow", toolName);
		}
	});
});

describe("who may answer", () => {
	const request: PermissionRequest = {
		permissionId: "perm_1",
		tool: { name: MCP.call, connector: "github", tool: "issues.create" },
		arguments: {},
		reason: "because",
		answers: ["allow", "deny"],
		approver: "Denis",
		askedBy: "Denis",
		origin: { connector: "telegram", externalConversationId: "-1001234", externalActorId: "8811" },
		askedAt: 0,
	};
	const grant = { approver: "Denis", actors: { "8811": "Denis", "9999": "Ilya" } };

	it("accepts the approver the connector is configured with, and nobody else", () => {
		assert.deepEqual(mayAnswer(request, grant, { externalActorId: "8811" }), { ok: true, by: "Denis" });
		const other = mayAnswer(request, grant, { externalActorId: "9999" });
		assert.equal(other.ok, false);
		assert.match(other.ok ? "" : other.reason, /not the approver/);
	});

	it("refuses an answer with no actor, and a connector with no approver", () => {
		assert.equal(mayAnswer(request, grant, {}).ok, false);
		const none = mayAnswer(request, { actors: { "8811": "Denis" } }, { externalActorId: "8811" });
		assert.equal(none.ok, false);
	});

	it("refuses a question that came through another connector, even for the same person", () => {
		// Two connectors whose approver is the same roster name are two seats, not one: the glossary says "a request that
		// came through it", and the id alone must not carry authority across connectors.
		const elsewhere = mayAnswer(request, { ...grant, connector: "slack" }, { externalActorId: "8811" });
		assert.equal(elsewhere.ok, false);
		assert.match(elsewhere.ok ? "" : elsewhere.reason, /came through/);
		assert.equal(mayAnswer(request, { ...grant, connector: "telegram" }, { externalActorId: "8811" }).ok, true);
	});

	it("routes a question to the person who asked, and leaves it pending when that person is not the approver", () => {
		const integrations = {
			telegram: {
				enabled: true,
				connector: {
					user: { actors: { "8811": "Denis", "9999": "Ilya" }, conversations: [], approver: "Denis" },
					state: [],
					trustMarkers: false,
				},
			},
		} as unknown as Record<string, Integration>;
		assert.deepEqual(surfaceFor(request, integrations), { connector: "telegram", conversation: "-1001234" });
		const askedByIlya = {
			...request,
			askedBy: "Ilya",
			origin: { connector: "telegram", externalConversationId: "-1001234", externalActorId: "9999" },
		};
		assert.equal(surfaceFor(askedByIlya, integrations), undefined, "nobody's words are sent to a room for approval");
	});

	it("names the approver the operator configured on the connector that carried the turn", () => {
		const integrations = {
			telegram: {
				enabled: true,
				connector: { user: { actors: {}, conversations: [], approver: "Denis" }, state: [], trustMarkers: false },
			},
		} as unknown as Record<string, Integration>;
		const carried = { kind: "connector" as const, origin: request.origin! };
		assert.equal(approverFor(carried, integrations), "Denis");
		assert.equal(
			approverFor({ kind: "console" }, integrations),
			undefined,
			"a console turn has no connector to name one",
		);
	});
});

/** A script whose only call reaches a tool that declared nothing about its effect. */
const CLOSE_SCRIPT = `const r = await tools.mcp_call({ integration: "github", tool: "issues.close", arguments: { title: "Pager" } });
return r.content[0].text;`;

/** Wait until `ready` holds, so a question a turn asks is not raced by the assertion that looks for it. */
async function until(ready: () => Promise<boolean>): Promise<boolean> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (await ready()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return ready();
}

/** A turn the test starts but does not await, so a question can be answered while it waits. */
async function startTurn(runtime: Awaited<ReturnType<typeof boot>>, content: string) {
	const submission = await (await runtime.conversation()).submit({ type: "input", content }, BACKGROUND_CONTEXT);
	return submission;
}

/** The one script result in the transcript's turn, or an empty string while the turn has not produced it. */
async function lastScript(runtime: Awaited<ReturnType<typeof boot>>): Promise<string> {
	const page = await (await runtime.conversation()).entries({}, 1000, undefined, BACKGROUND_CONTEXT);
	for (const entry of page.items) {
		const message = entry.kind === "pi.tool-result" ? entry.model?.[0] : undefined;
		if (message?.role === "toolResult" && message.toolName === "codemode") {
			return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		}
	}
	return "";
}

describe("the book", () => {
	it("settles a duplicate answer the same way whichever order it is read in", () => {
		// The book reads newest-first and the door reads oldest-first, so an exact tie has to be broken by what the answer
		// does rather than by which page it landed on: otherwise one side says deny and the call runs anyway.
		const deny: PermissionAnswer = { permissionId: "p", answer: "deny", at: 7 };
		const allow: PermissionAnswer = { permissionId: "p", answer: "allow", at: 7 };
		const cancelled: PermissionAnswer = { permissionId: "p", answer: "cancelled", at: 7 };
		for (const order of [
			[allow, deny],
			[deny, allow],
			[allow, cancelled],
			[cancelled, allow],
		] as const) {
			const settled = new Map<string, PermissionAnswer>();
			for (const answer of order) keepEarliest(settled, answer);
			assert.notEqual(settled.get("p")?.answer, "allow", order.map((answer) => answer.answer).join(","));
		}
		// And an earlier answer still beats a later one, which is the rule itself.
		const earlier = new Map<string, PermissionAnswer>();
		keepEarliest(earlier, { permissionId: "p", answer: "allow", at: 1 });
		keepEarliest(earlier, { permissionId: "p", answer: "deny", at: 2 });
		assert.equal(earlier.get("p")?.answer, "allow");
	});

	it("drops the waiter it registered when the answer is already in the log", async () => {
		// The recovery path this gateway advertises: the answer was written, the process died before the intent, and the
		// next hook reads the answer on its first pass. The waiter registered before that read has nothing to wait for, and
		// an abandoned waiter rejects when the invocation ends — an unhandled rejection, which takes the process down.
		const book = new PermissionBook();
		const request: PermissionRequest = {
			permissionId: "perm_1",
			tool: { name: "mcp_call", connector: "github", tool: "issues.create" },
			arguments: { title: "Pager" },
			reason: "the service declares that its effect needs approval",
			answers: ["allow", "deny"],
			askedAt: 1,
		};
		const entry = {
			kind: PERMISSION_ANSWER_ENTRY_KIND,
			data: { permissionId: "perm_1", answer: "allow", by: "Denis", at: 2 },
		};
		const api: HookCommitter = {
			conversationId: 1 as unknown as HookCommitter["conversationId"],
			commit: async (change) => {
				await change({
					scanEntries: async () => ({ items: [entry] }),
				} as never);
			},
		};
		const controller = new AbortController();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const answer = await book.ask(api, request, { abortSignal: controller.signal } as never);
			assert.deepEqual(answer, { permissionId: "perm_1", answer: "allow", by: "Denis", at: 2 });
			controller.abort(new Error("Task 1 invocation has ended"));
			await new Promise((resolve) => setTimeout(resolve, 25));
			assert.deepEqual(unhandled, [], "the abandoned waiter is gone, not failing in the background");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

describe("the book", () => {
	it("does not fail into nothing when the turn is stopped while the answer is being read", async () => {
		// The ordering the handled-at-birth marker exists for: `/stop` lands while the fold is still reading, so the waiter
		// is already rejected by the time the read comes back with the answer the previous process wrote. Abandoning that
		// promise used to be an unhandled rejection, and an unhandled rejection takes the process down.
		const book = new PermissionBook();
		const request: PermissionRequest = {
			permissionId: "perm_1",
			tool: { name: "mcp_call", connector: "github", tool: "issues.create" },
			arguments: { title: "Pager" },
			reason: "the service declares that its effect needs approval",
			answers: ["allow", "deny"],
			askedAt: 1,
		};
		const entry = {
			kind: PERMISSION_ANSWER_ENTRY_KIND,
			data: { permissionId: "perm_1", answer: "allow", by: "Denis", at: 2 },
		};
		const controller = new AbortController();
		const api: HookCommitter = {
			conversationId: 1 as unknown as HookCommitter["conversationId"],
			commit: async (change) => {
				controller.abort(new Error("Task 1 invocation has ended"));
				await change({ scanEntries: async () => ({ items: [entry] }) } as never);
			},
		};
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const answer = await book.ask(api, request, { abortSignal: controller.signal } as never);
			assert.equal(answer.answer, "allow", "the answer written before the stop is still the answer");
			await new Promise((resolve) => setTimeout(resolve, 25));
			assert.deepEqual(unhandled, [], "the stopped waiter did not reject into nothing");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

describe("the gateway at runtime", () => {
	it("asks before a required tool runs, and runs it once when the answer is allow", async () => {
		const server = await fakeServer([SEARCH_TOOL, GUARDED_TOOL], () => ({
			content: [{ type: "text", text: "CREATED" }],
		}));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			steps: scriptThenSpeak(TWO_CALLS),
		});
		try {
			const submission = await startTurn(runtime, "Open the issue.");
			assert.ok(
				await until(async () => (await runtime.permissions.pending()).length === 1),
				"the question was committed",
			);
			const [request] = await runtime.permissions.pending();
			assert.equal(request?.tool.name, MCP.call);
			assert.equal(request?.tool.tool, "issues.create");
			assert.match(request?.reason ?? "", /needs approval/);
			assert.deepEqual(
				server.calls.map((call) => call.name),
				["issues.search"],
				"nothing ran past the question",
			);

			const settled = await runtime.permissions.answer(request!.permissionId, "allow", "Denis");
			assert.deepEqual(settled, { settled: true });
			await submission.wait(BACKGROUND_CONTEXT);
			assert.deepEqual(
				server.calls.map((call) => call.name),
				["issues.search", "issues.create"],
				"the approved call ran once",
			);
			assert.match(await lastScript(runtime), /Script completed/);
			assert.deepEqual(await runtime.permissions.pending(), [], "and the question is closed");
		} finally {
			await runtime.close();
		}
	});

	it("returns a denial as a structured result, and never runs the call", async () => {
		const server = await fakeServer([SEARCH_TOOL, GUARDED_TOOL], () => ({
			content: [{ type: "text", text: "CREATED" }],
		}));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			steps: scriptThenSpeak(TWO_CALLS),
		});
		try {
			const submission = await startTurn(runtime, "Open the issue.");
			assert.ok(await until(async () => (await runtime.permissions.pending()).length === 1));
			const [request] = await runtime.permissions.pending();
			await runtime.permissions.answer(request!.permissionId, "deny", "Denis");
			await submission.wait(BACKGROUND_CONTEXT);
			assert.deepEqual(
				server.calls.map((call) => call.name),
				["issues.search"],
				"the denied call never reached it",
			);
			const script = await lastScript(runtime);
			assert.match(script, /Script failed/, "the script was told the call did not run");
			assert.match(script, /"denied":true/, "and the result is a structured refusal, not a sentence");
			assert.match(script, /issues\.create/);
		} finally {
			await runtime.close();
		}
	});

	it("asks for a not_required tool when the operator has not trusted that connector's markers", async () => {
		const server = await fakeServer([SEARCH_TOOL], () => ({ content: [{ type: "text", text: "ok" }] }));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: UNTRUSTED },
			transport: () => server.transport,
			steps: scriptThenSpeak(SEARCH_SCRIPT),
		});
		try {
			const submission = await startTurn(runtime, "Search.");
			assert.ok(await until(async () => (await runtime.permissions.pending()).length === 1));
			const [request] = await runtime.permissions.pending();
			assert.match(request?.reason ?? "", /not marked safe/);
			await runtime.permissions.answer(request!.permissionId, "allow", "Denis");
			await submission.wait(BACKGROUND_CONTEXT);
			assert.deepEqual(
				server.calls.map((call) => call.name),
				["issues.search"],
			);
		} finally {
			await runtime.close();
		}
	});

	it("asks for a tool that declared nothing, even on a connector whose markers are trusted", async () => {
		// The default is the one that matters: trusting a connector's markers trusts the ones it declared, and a tool that
		// said nothing has not said it is safe.
		const server = await fakeServer([SILENT_TOOL], () => ({ content: [{ type: "text", text: "closed" }] }));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			steps: scriptThenSpeak(CLOSE_SCRIPT),
		});
		try {
			const submission = await startTurn(runtime, "Close it.");
			assert.ok(await until(async () => (await runtime.permissions.pending()).length === 1));
			const [request] = await runtime.permissions.pending();
			assert.match(
				request?.reason ?? "",
				/needs approval/,
				"the tool declared no safety, so it declares no shortcut",
			);
			assert.equal(server.calls.length, 0, "nothing ran before the answer");
			await runtime.permissions.answer(request!.permissionId, "allow", "Denis");
			await submission.wait(BACKGROUND_CONTEXT);
			assert.deepEqual(
				server.calls.map((call) => call.name),
				["issues.close"],
			);
		} finally {
			await runtime.close();
		}
	});

	it("lets an allowed tool through without a question, and refuses a denied one without asking", async () => {
		const allowed = await fakeServer([SEARCH_TOOL], () => ({ content: [{ type: "text", text: "ok" }] }));
		const allowedDirectory = await temporaryDirectory();
		const permissive = await boot(allowedDirectory, {
			integrations: { github: ALLOWS_SEARCH },
			transport: () => allowed.transport,
			steps: scriptThenSpeak(SEARCH_SCRIPT),
		});
		try {
			await turn(permissive, "Search.");
			assert.deepEqual(await permissive.permissions.pending(), [], "the rule settled it without a person");
			assert.deepEqual(
				allowed.calls.map((call) => call.name),
				["issues.search"],
			);
		} finally {
			await permissive.close();
		}

		const denied = await fakeServer([SEARCH_TOOL], () => ({ content: [{ type: "text", text: "ok" }] }));
		const deniedDirectory = await temporaryDirectory();
		const closed = await boot(deniedDirectory, {
			integrations: {
				github: { ...GITHUB, connector: { state: [], trustMarkers: true, policy: { deny: ["issues.search"] } } },
			},
			transport: () => denied.transport,
			steps: scriptThenSpeak(SEARCH_SCRIPT),
		});
		try {
			await turn(closed, "Search.");
			assert.deepEqual(await closed.permissions.pending(), [], "a refusal is not a question");
			assert.deepEqual(denied.calls, [], "nothing ran");
			assert.match(await lastScript(closed), /"denied":true/);
			assert.match(await lastScript(closed), /the operator denies/);
		} finally {
			await closed.close();
		}
	});

	it("cancels the wait on stop, and a late answer changes nothing", async () => {
		const server = await fakeServer([SEARCH_TOOL, GUARDED_TOOL], () => ({
			content: [{ type: "text", text: "ok" }],
		}));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			// One step: the script. The turn never gets past the question, which is the point.
			steps: [
				fauxAssistantMessage([fauxToolCall("codemode", { code: TWO_CALLS }, { id: "script" })], {
					stopReason: "toolUse",
				}),
			],
		});
		try {
			await startTurn(runtime, "Open the issue.");
			assert.ok(await until(async () => (await runtime.permissions.pending()).length === 1));
			const [request] = await runtime.permissions.pending();
			await (await runtime.conversation()).abort(BACKGROUND_CONTEXT);
			assert.ok(
				await until(async () => (await runtime.permissions.pending()).length === 0),
				"the cancelled question stops being pending",
			);
			const late = await runtime.permissions.answer(request!.permissionId, "allow", "Denis");
			assert.equal(late.settled, false);
			assert.match(late.reason ?? "", /cancelled/);
			assert.deepEqual(
				server.calls.map((call) => call.name),
				["issues.search"],
				"the read before the question ran, and the call after it never did",
			);
		} finally {
			await runtime.close();
		}
	});
});

describe("a restart while a call waits", () => {
	it("finds the question, runs only the approved call, and repeats nothing it already did", async () => {
		const directory = await temporaryDirectory();
		const child = spawn(
			process.execPath,
			[
				"--experimental-strip-types",
				join(fileURLToPath(new URL(".", import.meta.url)), "support", "restart-child.ts"),
				directory,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += String(chunk);
		});
		let err = "";
		child.stderr.on("data", (chunk) => {
			err += String(chunk);
		});
		const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
		assert.equal(code, 9, `the child must die where it said it would: ${err.slice(-800)}`);
		// The hand-off is a file, not stdout: the boot logs there too, and a log line must not be able to corrupt it.
		const reached = JSON.parse(await readFile(join(directory, "child.json"), "utf8")) as {
			submissionId?: string;
			permissionId?: string;
		};
		assert.ok(reached.permissionId, `the child asked a question: ${out.slice(-400)}${err.slice(-400)}`);

		// What the service saw before the crash: the read, and nothing of the effect.
		assert.equal(await readFile(join(directory, "calls.log"), "utf8"), 'issues.search {"query":"bug"}\n');

		const server = await fakeServer([SEARCH_TOOL, GUARDED_TOOL], (name, args) => {
			// The parent's server appends to the same file: the tally is across both processes.
			appendFileSync(join(directory, "calls.log"), `${name} ${JSON.stringify(args)}\n`);
			return { content: [{ type: "text", text: `${name} done` }] };
		});
		const reopened = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			// What the resumed turn does after the script: answer the reader, then close with prose.
			steps: scriptThenSpeak("").slice(1),
			persist: true,
		});
		try {
			const pending = await reopened.permissions.pending();
			assert.deepEqual(
				pending.map((request) => request.permissionId),
				[reached.permissionId],
				"the question survived the crash, with the id the dead process minted",
			);
			assert.deepEqual(server.calls, [], "nothing runs before the answer, on this side either");

			// One settle before the answer. Answering inside the boot's own tick — before the resumed task has taken its
			// invocation — makes `pi-durable` reject a promise bound to that invocation (`Task N invocation has ended`) even
			// though the run then finishes correctly; nothing else about the restart is timing-dependent. Twenty-five
			// milliseconds is a hundred times the window, and the question is a person's to answer, not a race.
			await new Promise((resolve) => setTimeout(resolve, 25));
			await reopened.permissions.answer(reached.permissionId!, "allow", "Denis");
			const handle = await reopened.harness.submission(
				reached.submissionId as unknown as SubmissionId,
				BACKGROUND_CONTEXT,
			);
			const outcome = await handle?.wait(BACKGROUND_CONTEXT);
			assert.equal(outcome?.status, "done", "the run the crash interrupted finished");

			const calls = (await readFile(join(directory, "calls.log"), "utf8")).trim().split("\n");
			assert.deepEqual(
				calls.map((line) => JSON.parse(`"${line.split(" ")[0]}"`)),
				["issues.search", "issues.create"],
				"the read ran once before the crash and was not repeated; the approved effect ran once",
			);
			assert.deepEqual(await reopened.permissions.pending(), []);
		} finally {
			await reopened.close();
		}
	});
});
