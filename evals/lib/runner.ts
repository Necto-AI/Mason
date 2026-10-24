/**
 * Run one scenario against a real model, in a throwaway home, and hand back what the reader saw and what the agent did.
 *
 * Everything real is reused: the production prompt registry, the harness, the projection that decides what a reader
 * sees, and `delivery`. Everything expensive or unpredictable is replaced: tools answer from the scenario, and the home
 * is a temp directory that no other test or eval can see.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationView } from "@earendil-works/pi-durable";
import { projectTranscript } from "../../src/server/projection.ts";
import { DELIVERY_REMINDER } from "../../src/shared/contract.ts";
import { formatPrompt } from "../../src/server/hooks.ts";
import { openAgentRuntime } from "../../src/server/runtime.ts";
import { Delivery } from "../../src/server/extensions/delivery.ts";
import { Memory } from "../../src/server/extensions/memory.ts";
import { GenerateSandboxedUiExtension } from "../../src/server/extensions/sandboxed-ui.ts";
import { housePaths, HOUSE_ENTRIES, logPathFor, type HousePaths } from "../../src/server/house.ts";
import { Prompt } from "../../src/server/prompt.ts";
import { StubTools } from "./stubs.ts";
import type { Scenario, Trace } from "./scenario.ts";

export interface RunOptions {
	readonly model: { provider: string; modelId: string };
	readonly timeoutMs?: number;
	readonly onProgress?: (line: string) => void;
}

/** The extensions a scenario runs with: the prompt, the memory and delivery tools, the widget tool, and stubs. */
const CONTEXT: Context = BACKGROUND_CONTEXT;

export async function runScenario(scenario: Scenario, options: RunOptions): Promise<{ trace: Trace; logText: string }> {
	const directory = await mkdtemp(join(tmpdir(), `mason-eval-${scenario.id}-`));
	const stub = StubTools(scenario, [directory, join(directory, "workspace")]);

	try {
		await seed(directory, scenario);
		const runtime = await openAgentRuntime(CONTEXT, {
			dataDir: join(directory, "data"),
			houseHome: directory,
			workspaceDir: join(directory, "workspace"),
			storage: "memory",
			model: options.model,
			extensions: [stub],
			// The stubs stand in for `coding-tools`; the base repair would put the real ones back.
			selection: [Prompt, Memory, Delivery, GenerateSandboxedUiExtension, stub],
			repairBase: false,
			onReport: (error) => options.onProgress?.(`[report] ${String(error)}`),
		});

		try {
			const conversation = await runtime.conversation();
			const turns: { delivered: number; status: string }[] = [];
			let deliveredBefore = 0;
			for (const turn of scenario.turns) {
				const status = await submit(conversation, turn, options.timeoutMs ?? 180_000);
				const view = (await runtime.viewState(CONTEXT)).value;
				// The view is cumulative: what this turn delivered is the growth since the last one, so a later turn
				// that says nothing cannot borrow the message an earlier turn already delivered.
				const deliveredNow = projectTranscript(view).filter((item) => item.kind === "delivered").length;
				turns.push({ delivered: deliveredNow - deliveredBefore, status });
				deliveredBefore = deliveredNow;
			}
			const view = (await runtime.viewState(CONTEXT)).value;
			return { trace: collect(scenario, options.model, view, turns), logText: await readLog(directory) };
		} finally {
			await runtime.close();
		}
	} catch (error) {
		return {
			trace: {
				scenario: scenario.id,
				model: `${options.model.provider}/${options.model.modelId}`,
				delivered: [],
				notices: [],
				toolCalls: [],
				widgets: 0,
				widgetArguments: undefined,
				inputTokens: 0,
				outputTokens: 0,
				reminders: 0,
				turns: [],
				finished: false,
				error: error instanceof Error ? error.message : String(error),
			},
			logText: "",
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

type Turn = Scenario["turns"][number];

async function submit(conversation: Conversation, turn: Turn, timeoutMs: number): Promise<string> {
	const content =
		turn.hook === undefined
			? (turn.text ?? "")
			: `[EVENT HOOK: ${turn.hook.name}]\n${formatPrompt(
					{
						id: turn.hook.name,
						name: turn.hook.name,
						description: turn.hook.description ?? "",
						enabled: true,
						promptTemplate: turn.hook.description ?? "Check in.",
						fireCount: 0,
					},
					turn.hook.payload,
					new Date().toISOString(),
				)}`;
	const submission = await conversation.submit({ type: "input", content }, CONTEXT);
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`turn timed out after ${timeoutMs}ms`)), timeoutMs);
	});
	try {
		const settled = await Promise.race([submission.wait(CONTEXT), timeout]);
		if (settled.status !== "done") throw new Error(`turn settled as ${settled.status}`);
		return settled.status;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function seed(home: string, scenario: Scenario): Promise<void> {
	await seedHome(home, scenario.home ?? {});
}

/**
 * Where a scenario's file lands: the path `housePaths` resolves it to.
 *
 * The prompt reads the soul from `service/soul.md` — a file no tool can see — and the profile and the skills index from
 * `agent/`. A seeder that planted `soul.md` under `agent/` put every scenario's persona in a file nothing reads, so all
 * six ran on the shipped default soul and still looked plausible, because the scenario text overlaps it.
 */
export function seedPath(paths: HousePaths, file: string): string {
	const name = file.split("/")[0] ?? file;
	const entry = HOUSE_ENTRIES.find((candidate) => candidate.name === name);
	// A file mason has never heard of belongs with the agent's own: that is the half the tool machine sees.
	return join(entry?.half === "service" ? paths.serviceDir : paths.agentDir, file);
}

/** Plant a scenario's `home` files before the runtime opens the home, so `ensureHouse` fills the gaps around them. */
export async function seedHome(home: string, files: Record<string, string>): Promise<void> {
	const paths = housePaths(home);
	for (const [file, content] of Object.entries(files)) {
		const target = seedPath(paths, file);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
	}
}

/** What the reader received, and what the agent did to produce it — from the same projection the browser uses. */
function collect(
	scenario: Scenario,
	model: { provider: string; modelId: string },
	view: ConversationView,
	turns: { delivered: number; status: string }[],
): Trace {
	const items = projectTranscript(view);
	const delivered: string[] = [];
	const notices: string[] = [];
	const widgets: { content: unknown }[] = [];
	for (const item of items) {
		if (item.kind === "delivered") delivered.push(item.text);
		else if (item.kind === "notice") notices.push(item.text);
		else if (item.kind === "widget") widgets.push({ content: item.content });
	}
	// Every call the model made, in order, including the real tools a stub did not replace: `send_to_user`, `remember`
	// and the widget tool are the same delivery path the reader sees, so an eval must count what the harness committed.
	const calls = toolCallsOf(view);
	const widgetCall = calls.find((call) => call.name === "generateSandboxedUi");
	const usage = view.docs["pi.usage"] as { models?: Record<string, { input?: number; output?: number }> } | undefined;
	let input = 0;
	let output = 0;
	for (const entry of Object.values(usage?.models ?? {})) {
		input += entry.input ?? 0;
		output += entry.output ?? 0;
	}
	return {
		scenario: scenario.id,
		model: `${model.provider}/${model.modelId}`,
		delivered,
		notices,
		reminders: remindersOf(view),
		toolCalls: calls,
		widgets: widgets.length,
		widgetArguments: widgetCall?.args as Record<string, unknown> | undefined,
		inputTokens: input,
		outputTokens: output,
		turns,
		finished: true,
	};
}

/** How often the delivery gate had to intervene: one reminder entry per rescued turn. */
function remindersOf(view: ConversationView): number {
	let count = 0;
	for (const entry of view.entries) {
		if (entry.kind !== "pi.user") continue;
		const message = (entry.model?.[0] as { content?: unknown } | undefined)?.content;
		const text = typeof message === "string" ? message : "";
		if (text.trim() === DELIVERY_REMINDER.trim()) count += 1;
	}
	return count;
}

/** The model's tool calls in transcript order, read from the entries the harness committed. */
function toolCallsOf(view: ConversationView): { name: string; args: unknown }[] {
	const calls: { name: string; args: unknown }[] = [];
	for (const entry of view.entries) {
		if (entry.kind !== "pi.assistant") continue;
		const parts = (entry.model?.[0] as { content?: unknown[] } | undefined)?.content ?? [];
		for (const part of parts) {
			const call = part as { type?: string; name?: string; arguments?: unknown };
			if (call.type === "toolCall" && typeof call.name === "string") {
				calls.push({ name: call.name, args: call.arguments });
			}
		}
	}
	return calls;
}

async function readLog(home: string): Promise<string> {
	try {
		// The same layout the `remember` tool writes through: `logPathFor` needs the whole `HousePaths`, not just the home.
		return await readFile(logPathFor(housePaths(home)), "utf8");
	} catch {
		return "";
	}
}
