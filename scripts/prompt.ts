/**
 * `npm run prompt` — the agent's whole system prompt, as one turn in this home really sends it.
 *
 * Not a copy of the prompt's rules. The runtime opens against the operator's own home, a turn runs with the offline faux
 * model, and the `pi.system` entries that turn committed are printed in order: the sections as they were rendered from
 * `service/soul.md`, `agent/profile.md`, the skills index on the tool machine, and the integrations file, wrapped the way
 * the harness wraps them, plus the tools the request carried.
 *
 * Two reasons it is a script and not prose in a document. A prompt described by hand is a description that drifts from
 * the one the model receives, and every section here can read a file that changed a minute ago. And the turn costs
 * nothing: the model is the faux provider, the storage is memory, and `service/data` is a temporary directory, so
 * nothing durable is written to the operator's home.
 *
 * `--json` prints the same answer as data, for a diff or another program.
 */
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
} from "@earendil-works/pi-ai/utils/transcript";
import { type AgentRuntime, openAgentRuntime, type ResolvedModel } from "../src/server/runtime.ts";

const FAUX_MODEL = { provider: "faux", modelId: "faux-1" } as const;

interface Args {
	readonly home: string | undefined;
	readonly json: boolean;
	readonly cwd: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
	let home: string | undefined;
	let cwd: string | undefined;
	let json = false;
	for (const arg of argv) {
		if (arg === "--json") json = true;
		else if (arg.startsWith("--home=")) home = arg.slice("--home=".length);
		else if (arg.startsWith("--cwd=")) cwd = arg.slice("--cwd=".length);
		else throw new Error(`unknown argument ${arg}; expected --home=<path>, --cwd=<path> or --json`);
	}
	return { home, cwd, json };
}

/** A turn's worth of offline model: one `reply`, then the round that answers it. */
function fauxAccess(): ResolvedModel {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage(fauxText("the prompt, rendered")), fauxAssistantMessage(fauxText("done"))]);
	return { models, ref: FAUX_MODEL, faux: true };
}

/** One `pi.system` entry's sections, and the tools that rode with it. */
interface Rendered {
	readonly sections: Array<{ readonly key: string; readonly text: string }>;
	readonly tools: readonly { readonly name: string; readonly description: string }[];
	readonly prompt: string;
}

/**
 * The prompt of one committed turn, read back from the durable entries and replayed by pi-ai's own rules.
 *
 * Neither half is merged here. A later turn patches a changed section rather than restating the prompt, and tool
 * changes arrive as `toolsAdded` / `toolsRemoved`, so the replay is the one the model sees and it belongs to the vendor:
 * `getCurrentSystemMessage` and `getCurrentTools` are that replay.
 */
async function rendered(runtime: AgentRuntime): Promise<Rendered> {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 500, undefined, BACKGROUND_CONTEXT);
	const entries = [...page.items].reverse();
	const messages = entries.filter((entry) => entry.kind === "pi.system").flatMap((entry) => entry.model ?? []);
	const system = getCurrentSystemMessage(messages);
	if (system === undefined) throw new Error("no `pi.system` entry was committed: the prompt was never planned");
	// The named sections, in order. A tag-less section (the soul) is replayed as `content` by some paths and as a section
	// by others, so the content is the fallback rather than an entry of its own: printing both would print the soul twice.
	const named = Object.entries(system.sections ?? {}).flatMap(([key, text]) => (text === null ? [] : [{ key, text }]));
	const opening = typeof system.content === "string" ? system.content.trim() : "";
	const sections = named.length > 0 ? named : opening === "" ? [] : [{ key: "preamble", text: opening }];
	return {
		sections,
		tools: getCurrentTools(messages).map((tool) => ({ name: tool.name, description: tool.description ?? "" })),
		prompt: getCurrentSystemPrompt(messages),
	};
}

const args = parseArgs(process.argv.slice(2));
const home = args.home ?? process.env.MASON_HOME ?? join(homedir(), ".mason");
// The state a boot writes — `hooks.json` — goes to a temporary directory, so the operator's `service/data` is untouched.
const dataDir = await mkdtemp(join(tmpdir(), "mason-prompt-"));

const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
	houseHome: home,
	dataDir,
	storage: "memory",
	modelAccess: fauxAccess(),
	...(args.cwd === undefined ? {} : { workspaceDir: args.cwd }),
	onReport: (error) => console.warn(`[prompt] a section failed and kept its text: ${String(error)}`),
});

try {
	const conversation = await runtime.conversation();
	const settled = await (
		await conversation.submit({ type: "input", content: "render the prompt" }, BACKGROUND_CONTEXT)
	).wait(BACKGROUND_CONTEXT);
	if (settled.status !== "done") throw new Error(`the render turn ended as ${settled.status}`);

	const { sections, tools, prompt } = await rendered(runtime);

	if (args.json) {
		console.log(JSON.stringify({ home, prompt, sections, tools }, null, "\t"));
	} else {
		console.log(`# the system prompt of ${home}`);
		console.log(`# ${sections.length} sections, ${prompt.length} characters, ${tools.length} tools\n`);
		for (const section of sections) console.log(section.text, "\n");
		console.log(`# tools, in the order the request carries them:\n#   ${tools.map((tool) => tool.name).join(", ")}`);
	}
} finally {
	await runtime.close();
}
