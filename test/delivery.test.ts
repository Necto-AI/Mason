/**
 * `reply` is the one channel the agent's words reach the reader through, so the registration facts the
 * durability rules depend on are pinned here: the replay policy, the unconditional registration, and the fact that
 * `execute()` delivers by returning.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Delivery, sendTool } from "../src/server/extensions/delivery.ts";
import { Prompt } from "../src/server/prompt.ts";
import {
	type AgentRuntime,
	BASE_EXTENSIONS,
	openAgentRuntime,
	unconditionalExtensionNames,
} from "../src/server/runtime.ts";

/**
 * Every extension a boot installs unconditionally, in order: the base list, then the ones `openAgentRuntime` builds per
 * boot — delegation and code mode here, since this home has no integration. `openRuntime` below writes nothing to an MCP
 * server, so the per-boot part is those two; they are named rather than assumed, and the runtime's own list is what is
 * asserted against, so a base extension added later is covered without a second list going stale.
 */
const BOOT_EXTENSIONS: readonly string[] = unconditionalExtensionNames(["subagent", "codemode"]);

test("send is replay-unsafe, so a restart never delivers the same message twice", () => {
	assert.equal(sendTool.name, "send");
	// Explicit in the registration, though it is pi's default: an interrupted call settles as an `interrupted`
	// error result instead of rerunning, and a rerun would send the reader the message a second time.
	assert.equal(sendTool.replay, "unsafe");
});

test("the delivery extension rides in the base extension list, not behind a toggle", () => {
	assert.deepEqual(
		Delivery.tools?.map((tool) => tool.name),
		["send"],
	);
	assert.ok(
		BASE_EXTENSIONS.some((extension) => extension.name === Delivery.name),
		"every conversation can speak",
	);
});

test("the tool description says the rule the refusal enforces: call it directly, never from inside a script", () => {
	// The refusal is the backstop for a model that sends from a script anyway; the description is what asks it not to,
	// so the sentence the refusal answers is pinned here.
	assert.match(sendTool.description, /never from inside a script/);
});

/** The same agent over the same storage in the same directory: a restart. */
function openRuntime(directory: string): Promise<AgentRuntime> {
	return openAgentRuntime(BACKGROUND_CONTEXT, {
		dataDir: join(directory, "data"),
		workspaceDir: directory,
		// A temporary home: the runtime creates `soul.md`, `log/` and `skills/` there, never in the real `~/.mason`.
		houseHome: join(directory, "house"),
		faux: true,
		onReport: () => {},
	});
}

/** The selection as it is stored, not as it is resolved. */
async function storedSelection(runtime: AgentRuntime): Promise<unknown> {
	const root = await runtime.conversation();
	return root.commit(async (tx) => {
		// The doc is a live overlay, so it is copied into plain JSON inside the transaction that reads it.
		const stored = (await tx.doc(AgentDoc, root.id)).extensions;
		return JSON.parse(JSON.stringify(stored)) as unknown;
	}, BACKGROUND_CONTEXT);
}

/** The names of the entries a conversation has, so a repair that writes nothing is visible as nothing. */
async function entryCount(runtime: AgentRuntime): Promise<number> {
	const root = await runtime.conversation();
	const page = await root.entries({}, 1000, undefined, BACKGROUND_CONTEXT);
	return page.items.length;
}

test("a selection stored before delivery existed still speaks after a reopen", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mason-stale-extensions-"));
	try {
		const before = await openRuntime(directory);
		try {
			// A `pi.agent` doc from before slice 1: an explicit array of names, without `delivery`. A stored array is
			// used verbatim, so nothing else brings delivery back.
			const root = await before.conversation();
			await root.configure({ extensions: [CodingTools, Prompt] }, BACKGROUND_CONTEXT);
		} finally {
			await before.close();
		}

		const after = await openRuntime(directory);
		try {
			const agent = await (await after.conversation()).agent(BACKGROUND_CONTEXT);
			const stored = [CodingTools.name, Prompt.name];
			assert.deepEqual(
				agent.extensions.map((extension) => extension.name),
				[...stored, ...BOOT_EXTENSIONS.filter((name) => !stored.includes(name))],
				"the missing base names are appended in base order, and the stored order survives",
			);
			assert.ok(
				agent.tools.some((tool) => tool.name === sendTool.name),
				"the model is offered the one way it can reach the reader",
			);
		} finally {
			await after.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a selection missing several base names gets them back in base order", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mason-stale-extensions-"));
	try {
		const before = await openRuntime(directory);
		try {
			// Only `coding-tools` is stored: every other base name is missing, so the order they are put back in is the
			// whole assertion.
			const root = await before.conversation();
			await root.configure({ extensions: [CodingTools] }, BACKGROUND_CONTEXT);
		} finally {
			await before.close();
		}

		const after = await openRuntime(directory);
		try {
			const agent = await (await after.conversation()).agent(BACKGROUND_CONTEXT);
			assert.deepEqual(
				agent.extensions.map((extension) => extension.name),
				[CodingTools.name, ...BOOT_EXTENSIONS.filter((name) => name !== CodingTools.name)],
				"the missing base names are appended in base order",
			);
		} finally {
			await after.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a selection stored as an edit is left as it is", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mason-stale-extensions-"));
	try {
		const before = await openRuntime(directory);
		try {
			// An edit, not a list: `{ remove }` already unions with the base selection, so it needs nothing and must
			// keep its shape. Turning it into a list would add `prompt` back and undo the edit.
			const root = await before.conversation();
			await root.configure({ extensions: { remove: [Prompt] } }, BACKGROUND_CONTEXT);
		} finally {
			await before.close();
		}

		const after = await openRuntime(directory);
		try {
			const stored = await storedSelection(after);
			assert.deepEqual(stored, { remove: ["prompt"] }, "the stored edit keeps its shape");
			const agent = await (await after.conversation()).agent(BACKGROUND_CONTEXT);
			assert.deepEqual(
				agent.extensions.map((extension) => extension.name),
				BOOT_EXTENSIONS.filter((name) => name !== Prompt.name),
				"the edit still removes what it removed, and the base selection still speaks",
			);
		} finally {
			await after.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a selection that is already complete is not written to", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mason-stale-extensions-"));
	try {
		const first = await openRuntime(directory);
		const before = await entryCount(first);
		await first.close();

		const second = await openRuntime(directory);
		try {
			assert.equal(await entryCount(second), before, "a repair with nothing to repair writes nothing");
		} finally {
			await second.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

/**
 * A turn's transcript, as `execute` reads it: `entries` oldest first, and whatever the tool appends is recorded.
 *
 * The tool's two jobs are both about what the transcript says — which entry started the turn, and which entry the call
 * leaves behind — so the fake is a log rather than a stub: an assertion reads the entry the reply committed, not a
 * return value alone.
 */
interface FakeEntry {
	id: number;
	kind: string;
	model?: unknown[];
	data?: unknown;
}

function apiFor(
	turn: { readonly callId: string; readonly entries?: readonly FakeEntry[] },
	appended: unknown[] = [],
): never {
	return {
		callId: turn.callId,
		conversationId: 1,
		commit: async (run: (tx: unknown) => Promise<unknown>) =>
			run({
				scanEntries: async () => ({ items: [...(turn.entries ?? [])].reverse(), next: undefined }),
				appendEntry: async (_conversationId: number, draft: unknown) => {
					appended.push(draft);
					return { id: appended.length, ...(draft as object) };
				},
			}),
	} as never;
}

/** A turn mason wrote itself: an ordinary `pi.user` entry. */
function localTurn(text: string): FakeEntry[] {
	return [{ id: 1, kind: "pi.user", model: [{ role: "user", content: text }] }];
}

/** A person's words through a connector: the origin is in the entry's data. */
function connectorTurn(text: string): FakeEntry[] {
	return [
		{
			id: 1,
			kind: "app.connector",
			model: [{ role: "user", content: text }],
			data: { origin: { connector: "telegram", ref: "team" } },
		},
	];
}

/** A fire: an `app.hook` entry, carrying an origin only when the fire named a conversation. */
function hookTurn(text: string, origin?: Record<string, string>): FakeEntry[] {
	return [
		{
			id: 1,
			kind: "app.hook",
			model: [{ role: "user", content: text }],
			data: {
				hookId: "team-chat",
				hookName: "Team chat message",
				payload: "hi",
				firedAt: "now",
				...(origin === undefined ? {} : { origin }),
			},
		},
	];
}

/** The text of a result, as the model reads it: the only channel a refusal has. */
function outputText(output: readonly { readonly type: string; readonly text?: string }[] | undefined): string {
	return (output ?? []).flatMap((item) => (item.type === "text" ? [item.text ?? ""] : [])).join("");
}

/** The one integration a connector reply can be routed to; every other test in this file boots a home with none. */
const TELEGRAM = {
	enabled: true,
	connector: {
		user: { owner: "8811" },
	},
} as const;

test("a local turn is delivered by the entry the call commits", async () => {
	const appended: unknown[] = [];
	const result = await sendTool.execute(
		{ text: "Standup moved to nine." },
		apiFor({ callId: "call-7", entries: localTurn("Move standup.") }, appended),
		{} as never,
	);
	assert.equal(result.isError, undefined);
	assert.equal(outputText(result.output), "delivered to the transcript");
	// The commit is the delivery: one `app.reply` entry, no target, no origin — the transcript is the medium.
	assert.deepEqual(appended, [
		{
			kind: "app.reply",
			data: { deliveryId: "reply:call-7", blocks: [{ type: "text", text: "Standup moved to nine." }] },
		},
	]);
});

test("a connector turn commits its words and records the origin, under the id the entry and the stream share", async () => {
	const appended: unknown[] = [];
	const result = await sendTool.execute(
		{ text: "Nothing until Thursday." },
		apiFor({ callId: "call-8", entries: connectorTurn("[from Denis] what is on my calendar") }, appended),
		{} as never,
	);
	assert.equal(outputText(result.output), "delivered to the transcript");
	// One entry: the words, and the origin that says which append they answer. There is no address to name — the
	// conversation is the one surface — so nothing is queued and nothing is addressed (#201).
	assert.deepEqual(appended, [
		{
			kind: "app.reply",
			data: {
				deliveryId: "reply:call-8",
				blocks: [{ type: "text", text: "Nothing until Thursday." }],
				origin: { connector: "telegram", ref: "team" },
			},
		},
	]);
});

test("a fire that named its conversation answers in it, and one that did not records the work and reaches nobody", async () => {
	const { setIntegrations } = await import("../src/server/integrations.ts");
	setIntegrations({ telegram: TELEGRAM as never });
	try {
		const withOrigin: unknown[] = [];
		const answered = await sendTool.execute(
			{ text: "on it" },
			apiFor(
				{
					callId: "call-9",
					entries: hookTurn("[EVENT: chat.message]", { connector: "telegram", ref: "team" }),
				},
				withOrigin,
			),
			{} as never,
		);
		assert.equal(outputText(answered.output), "delivered to the transcript");
		assert.deepEqual((withOrigin[0] as { data: { origin?: unknown } }).data.origin, {
			connector: "telegram",
			ref: "team",
		});
	} finally {
		setIntegrations({});
	}

	// A schedule, a repository event, a retry: the fire names no conversation, so no medium carries the words. The entry
	// is still committed — the work is recorded — and the result says nobody was reached rather than claiming a delivery.
	const appended: unknown[] = [];
	const orphan = await sendTool.execute(
		{ text: "Morning: three things need you." },
		apiFor({ callId: "call-10", entries: hookTurn("[ROUTINE: morning brief]") }, appended),
		{} as never,
	);
	assert.notEqual(orphan.isError, true);
	const text = outputText(orphan.output);
	assert.match(text, /nobody was reached/);
	assert.match(text, /in the transcript/);
	assert.equal(appended.length, 1, "the work is recorded even when nobody is reached");
	assert.equal(Object.hasOwn((appended[0] as { data: object }).data, "target"), false, "nothing was addressed");
});

test("an address the model names routes nothing: the turn's origin is the only destination there is", async () => {
	// The schema refuses the argument before a call reaches `execute`: `send` declares one property and closes the object,
	// so a model replaying an older prompt's `to` is told `invalid_arguments` rather than having the field quietly dropped.
	assert.equal(
		(sendTool.parameters as { readonly additionalProperties?: unknown }).additionalProperties,
		false,
		"an argument the schema does not declare is refused, not ignored",
	);
	const { setIntegrations } = await import("../src/server/integrations.ts");
	setIntegrations({ telegram: TELEGRAM as never });
	try {
		const appended: unknown[] = [];
		// This call bypasses that check, which is the point: an address that does arrive routes nothing. `send` has no
		// address parameter any more, so the words cannot be sent past the turn's own origin — and this turn has none, so
		// the message is recorded and nobody is reached. Naming a connector that exists does not make it a destination.
		const named = await sendTool.execute(
			{ text: "the brief", to: "telegram/team" } as never,
			apiFor({ callId: "call-11", entries: hookTurn("[ROUTINE: morning brief]") }, appended),
			{} as never,
		);
		assert.match(outputText(named.output), /nobody was reached/, "the named address reaches nobody");
		assert.equal(Object.hasOwn((appended[0] as { data: object }).data, "target"), false, "nothing was addressed");
	} finally {
		setIntegrations({});
	}
});

test("a turn with no input at all is read as a local turn, as a resumed one is", async () => {
	const result = await sendTool.execute(
		{ text: "Resuming." },
		apiFor({ callId: "call-13", entries: [] }),
		{} as never,
	);
	assert.equal(outputText(result.output), "delivered to the transcript");
});

test("a call made from inside a script is refused, and told where the message has to go", async () => {
	// A nested call's ID is `<parentCallId>/<key>`, which is what tells the two apart.
	const result = await sendTool.execute(
		{ text: "Standup moved to nine." },
		apiFor({ callId: "call-7/1", entries: localTurn("Move standup.") }),
		{} as never,
	);
	assert.equal(result.isError, true, "a nested delivery is an error, not a delivery");
	assert.match(outputText(result.output), /cannot deliver from inside a script/);
	assert.match(outputText(result.output), /call send from the turn/, "the model is told what to do");
});
