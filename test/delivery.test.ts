/**
 * `send_to_user` is the one channel the agent's words reach the reader through, so the registration facts the
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
import { Delivery, sendToUserTool } from "../src/server/extensions/delivery.ts";
import { generateSandboxedUiTool } from "../src/server/extensions/sandboxed-ui.ts";
import { DEFAULT_SOUL, Prompt } from "../src/server/prompt.ts";
import { BASE_EXTENSIONS, openAgentRuntime, type AgentRuntime, unconditionalExtensionNames } from "../src/server/runtime.ts";

/**
 * Every extension a boot installs unconditionally, in order: the base list, then the ones `openAgentRuntime` builds per
 * boot — code mode here, since this home has no integration. `openRuntime` below writes nothing to a tools face, so the
 * per-boot part is code mode alone; it is named rather than assumed, and the runtime's own list is what is asserted
 * against, so a base extension added later is covered without a second list going stale.
 */
const BOOT_EXTENSIONS: readonly string[] = unconditionalExtensionNames(["codemode"]);

test("send_to_user is replay-unsafe, so a restart never delivers the same message twice", () => {
	assert.equal(sendToUserTool.name, "send_to_user");
	// Explicit in the registration, though it is pi's default: an interrupted call settles as an `interrupted`
	// error result instead of rerunning, and a rerun would send the reader the message a second time.
	assert.equal(sendToUserTool.replay, "unsafe");
});

test("the delivery extension rides in the base extension list, not behind a toggle", () => {
	assert.deepEqual(
		Delivery.tools?.map((tool) => tool.name),
		["send_to_user"],
	);
	assert.ok(
		BASE_EXTENSIONS.some((extension) => extension.name === Delivery.name),
		"every conversation can speak",
	);
});

test("the tool descriptions say the rule the refusal enforces: call it directly, never from inside a script", () => {
	// The refusal is the backstop for a model that sends from a script anyway; the description is what asks it not to,
	// so the sentence the refusal answers is pinned here, for both tools that reach the reader.
	assert.match(sendToUserTool.description, /never from inside a script/);
	assert.match(generateSandboxedUiTool.description, /never from inside a script/);
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
				agent.tools.some((tool) => tool.name === sendToUserTool.name),
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
			assert.deepEqual(
				stored,
				{ remove: ["prompt"] },
				"the stored edit keeps its shape",
			);
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
			assert.equal(
				await entryCount(second),
				before,
				"a repair with nothing to repair writes nothing",
			);
		} finally {
			await second.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

/**
 * The corner of the tool's api those calls need: the call's ID, and the transcript read the turn's reader is decided
 * from. `input` is the message that started the turn — absent, as a resumed turn's would be, reads as the console.
 */
function apiFor(callId: string, input?: string): never {
	return { callId, conversationId: 1, commit: async () => input } as never;
}

test("execute only returns: the committed call is the delivery", async () => {
	// A model-issued call: its own ID, with no `/` in it, so a script's refusal does not apply.
	const result = await sendToUserTool.execute(
		{ message: "Standup moved to nine." },
		apiFor("call-7"),
		{} as never,
	);
	assert.deepEqual(result, { output: [{ type: "text", text: "delivered" }], details: { length: 22 } });
	assert.equal(result.isError, undefined);
	assert.equal(result.control, undefined);
});

/** The text of a result, as the model reads it: the only channel a refusal has. */
function outputText(output: readonly { readonly type: string; readonly text?: string }[] | undefined): string {
	return (output ?? []).flatMap((item) => (item.type === "text" ? [item.text ?? ""] : [])).join("");
}

test("a call made from inside a script is refused, and told where the message has to go", async () => {
	// A nested call's ID is `<parentCallId>/<key>`, which is what tells the two apart.
	const result = await sendToUserTool.execute(
		{ message: "Standup moved to nine." },
		apiFor("call-7/1"),
		{} as never,
	);
	assert.equal(result.isError, true, "a nested delivery is an error, not a delivery");
	assert.match(outputText(result.output), /cannot deliver from inside a script/);
	assert.match(outputText(result.output), /send it with send_to_user directly/, "the model is told what to do");
});

test("in a turn an event hook started, the delivery is refused with the tool that reaches the chat", async () => {
	// The reader is in a chat, and the turn's input is the one that says so: the tool reads it, not a flag.
	const result = await sendToUserTool.execute(
		{ message: "Привет!" },
		apiFor("call-9", "[EVENT HOOK: Team chat message]\nAnswer it in its chat with mcp__telegram__send_message."),
		{} as never,
	);
	assert.equal(result.isError, true, "nothing was delivered in the console's name");
	assert.match(outputText(result.output), /cannot reach the reader in this turn/);
	assert.match(outputText(result.output), /the call rejects/, "code mode reads it as a rejection, and it says so");
	assert.match(outputText(result.output), /mcp__telegram__send_message/, "it names the tool that does reach them");
	assert.match(outputText(result.output), /the chat the payload names/, "and the chat to answer in");
});
