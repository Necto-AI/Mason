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
	mayAnswer,
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

/** The decision inputs, with a catalog that knows one tool and says what the caller told it to say. */
function inputs(
	options: {
		readonly toolName?: string;
		readonly args?: Record<string, unknown>;
		readonly marker?: "required" | "not_required" | null;
		readonly integration?: Integration;
		readonly origin?: PermissionInputs["origin"];
	} = {},
): PermissionInputs {
	const marker = options.marker === undefined ? "required" : options.marker;
	return {
		toolName: options.toolName ?? MCP.call,
		args: options.args ?? { integration: "github", tool: "issues.create", arguments: {} },
		origin: options.origin ?? { kind: "console" },
		integrations: { github: options.integration ?? GITHUB },
		catalog: {
			approvalOf: (_integration, tool) => (marker === null || tool !== "issues.create" ? undefined : marker),
		},
	};
}

describe("the decision", () => {
	it("asks for a marker that is missing or unknown, because a server that said nothing said nothing about safety", () => {
		assert.equal(
			decide(inputs({ marker: null })).kind,
			"allow",
			"a tool the catalog no longer has is the call's problem",
		);
		assert.equal(decide(inputs({ integration: UNTRUSTED, marker: "required" })).kind, "ask");
	});

	it("asks for a required tool whatever the operator allowed, and never lets a marker loosen a rule", () => {
		assert.equal(decide(inputs({ integration: GITHUB, marker: "required" })).kind, "ask");
		const trusted: Integration = { ...GITHUB, connector: { state: [], trustMarkers: true } };
		const allowed = decide(inputs({ integration: trusted, marker: "required" }));
		assert.equal(allowed.kind, "ask", "`required` always asks: an allow rule cannot waive it");
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
				"--conditions=source",
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
		const reached = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as {
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
