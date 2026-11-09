/**
 * `mason init` — the common store, once per root, and nothing written before the provider answers.
 *
 * The three answers are a provider, a model and a key, and the order is the point: the key is checked with one real
 * completion before any of the three is stored (`docs/research/openclaw-cli.md` §1.6). A key that is stored first is a
 * bot that boots into a provider error on its first turn; a key that is tried first is a first run that ends in either
 * "the provider answered" or one sentence naming what was wrong.
 *
 * Running it a second time asks nothing. The store exists, the key is where it belongs, and the command says so —
 * which is what makes `mason onboard` safe to run again (#147, criterion 2). Passing a flag is the deliberate way to
 * change one, and that run verifies and rewrites like the first.
 *
 * The write is one commit under the auth lock: `common/settings.json`, `common/auth.json`, and `common/runtime.json` if
 * it does not exist yet, each copied aside with a timestamp before it is replaced.
 */
import { existsSync } from "node:fs";
import {
	assertCommonStoreReadable,
	commonPaths,
	commonReady,
	readCommonRuntime,
	writeCommonStore,
} from "../src/server/common.ts";
import {
	modelRows,
	openProviders,
	type ProviderAccess,
	providerIds,
	verifyCompletion,
} from "../src/server/provider.ts";
import { readRoot, refuseHomeEnv, rootPath } from "../src/server/root.ts";
import {
	choosePrompter,
	KEY_QUESTION,
	MissingAnswer,
	MODEL_QUESTION,
	PROVIDER_QUESTION,
	type Prompter,
} from "./wizard.ts";

export interface InitArgs {
	readonly provider?: string;
	readonly model?: string;
	readonly key?: string;
	readonly yes: boolean;
	readonly help: boolean;
}

export function usage(): string {
	return `usage: mason init [flags]

  The common store every bot under this root shares: the default provider and model, the key that answers for them, and
  the machine tools run on. It runs once per root — a second run asks nothing — and it verifies the key with one real
  completion before anything is written.

  --provider <id>      the provider to store; without it, the wizard asks
  --model <id>         the model to store; without it, the wizard asks
  --key <key>          the provider's API key; without it, the wizard asks without echoing
  --yes                take the flags it has and ask nothing; what CI and a script use
  --help               this

  The store is <MASON_ROOT or ~/.mason>/common, 0600, and nothing in it is ever printed again.`;
}

/** The flags, in the two spellings a person types. */
export function parseArgs(argv: readonly string[]): InitArgs {
	let provider: string | undefined;
	let model: string | undefined;
	let key: string | undefined;
	let yes = false;
	let help = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const flag = equals === -1 ? arg : arg.slice(0, equals);
		const inline = equals === -1 ? undefined : arg.slice(equals + 1);
		const value = (): string => {
			if (inline !== undefined) return inline;
			const next = argv[index + 1];
			if (next === undefined) throw new Error(`${flag} needs a value`);
			index += 1;
			return next;
		};
		switch (flag) {
			case "--provider":
				provider = value();
				break;
			case "--model":
				model = value();
				break;
			case "--key":
				key = value();
				break;
			case "--yes":
			case "-y":
				yes = true;
				break;
			case "--help":
			case "-h":
				help = true;
				break;
			default:
				throw new Error(`unknown argument ${arg}; \`mason init --help\` lists the flags`);
		}
	}
	return {
		...(provider === undefined ? {} : { provider }),
		...(model === undefined ? {} : { model }),
		...(key === undefined ? {} : { key }),
		yes,
		help,
	};
}

/** One provider's model list, short enough for a hint and complete enough to pick from. */
function modelHint(models: readonly string[]): string {
	if (models.length === 0) return "this provider publishes no models this build knows: name the one you mean";
	const shown = models.slice(0, 8).join(", ");
	return `one of ${shown}${models.length > 8 ? `, and ${models.length - 8} more` : ""}`;
}

/** The row that leads out of a catalog that does not hold the model a person wants. */
const TYPE_MODEL = "type-it-myself";

/**
 * The model, chosen from the catalog rather than recalled from memory.
 *
 * The list is the same one the provider question was built from — this build's own catalog, read offline — so a model id
 * is a thing a person recognizes instead of a string they have to get exactly right. The catalog is a snapshot and the
 * provider keeps serving, so the last row stays a text field: a model this build does not list is still an answer.
 *
 * A provider whose list is empty skips the question and asks for the id, because a list of one row that says "type it
 * yourself" is a text field with a menu in front of it. `fallback` is what a `--yes` run takes, and it is the catalog's
 * first model — the same answer an empty line has always meant here.
 */
async function askModel(prompter: Prompter, access: ProviderAccess, provider: string): Promise<string> {
	const rows = modelRows(access, provider);
	if (rows.length === 0)
		return await prompter.text(MODEL_QUESTION, { hint: modelHint([]), flag: "--model <id>", required: true });
	const picked = await prompter.pick(
		MODEL_QUESTION,
		[
			...rows,
			{
				value: TYPE_MODEL,
				label: "+ a model id I type myself",
				description: "for a model this build does not list",
				pinned: true,
			},
		],
		{
			flag: "--model <id>",
			fallback: rows[0]?.value,
			hint: `this build's catalog, read offline: ${rows.length} model${rows.length === 1 ? "" : "s"} for ${provider}`,
		},
	);
	if (picked !== TYPE_MODEL) return picked;
	return await prompter.text(MODEL_QUESTION, {
		hint: `the id exactly as ${provider} writes it`,
		flag: "--model <id>",
		required: true,
	});
}

/** The command. Returns an exit code rather than calling `process.exit`, so a test can run the flow in-process. */
export async function runInit(
	argv: readonly string[],
	options: { readonly prompter?: Prompter; readonly root?: string; readonly access?: ProviderAccess } = {},
): Promise<number> {
	let args: InitArgs;
	try {
		args = parseArgs(argv);
	} catch (error) {
		console.error(`[init] ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	if (args.help) {
		console.log(usage());
		return 0;
	}
	let prompter: Prompter | undefined;
	try {
		refuseHomeEnv();
		const root = readRoot(options.root ?? rootPath());
		const paths = commonPaths(root.root);
		const asked = args.provider !== undefined || args.model !== undefined || args.key !== undefined;
		if (!asked && (await commonReady(root.root))) {
			const runtime = await readCommonRuntime(root.root).catch(() => undefined);
			console.log(`[init] ${paths.dir} is already initialised; nothing asked, nothing written`);
			if (runtime !== undefined) console.log(`[init] tools run ${runtime.kind}`);
			return 0;
		}
		// The offline provider is chosen by the switch the runtime plays a model under, never by a provider id: a real
		// catalog has no "faux" provider, and `mason init` with PI_FAUX_MODEL=1 is the scripted first run.
		const access = options.access ?? (await openProviders({ faux: process.env.PI_FAUX_MODEL === "1" }));
		const texts = new Map<string, string>();
		if (args.model !== undefined) texts.set(MODEL_QUESTION, args.model);
		if (args.key !== undefined) texts.set(KEY_QUESTION, args.key);
		prompter = options.prompter ?? choosePrompter({ yes: args.yes, texts });
		const known = providerIds(access);
		const provider =
			args.provider ??
			(await prompter.pick(
				PROVIDER_QUESTION,
				known.map((id) => ({ value: id, label: id })),
				{ flag: "--provider <id>" },
			));
		if (!known.includes(provider))
			throw new Error(`there is no provider "${provider}": this build knows ${known.join(", ")}`);
		const model = args.model ?? (await askModel(prompter, access, provider));
		const key = access.faux
			? undefined
			: (args.key ??
				(await prompter.text(KEY_QUESTION, {
					hint: `stored in ${paths.auth}, 0600, and never printed again`,
					flag: "--key <key>",
					secret: true,
					required: true,
				})));
		// Before the completion, not after it: a store that cannot be rewritten is one sentence, and a spent verify is not.
		await assertCommonStoreReadable(root.root);
		console.log(`[init] verifying ${provider}/${model} with one completion…`);
		const reply = await verifyCompletion(access, { provider, modelId: model }, key);
		console.log(`[init] the provider answered: ${reply.slice(0, 60)}`);
		const wroteRuntime = !existsSync(paths.runtime);
		await writeCommonStore(root.root, {
			defaultProvider: provider,
			defaultModel: model,
			...(key === undefined ? {} : { key }),
		});
		// `writeCommonStore` writes `runtime.json` only when there is none, and the check has to be *before* the write:
		// testing it afterwards was a clause that could never be true.
		console.log(`[init] wrote ${paths.settings}, ${paths.auth}${wroteRuntime ? ` and ${paths.runtime}` : ""}`);
		console.log("[init] next: `mason new <name>` creates a bot, or `mason onboard` does both");
		return 0;
	} catch (error) {
		console.error(`[init] ${error instanceof Error ? error.message : String(error)}`);
		// A missing answer is not a failure of the store: it is a run that needs a terminal or a flag.
		return error instanceof MissingAnswer ? 2 : 1;
	} finally {
		prompter?.close();
	}
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await runInit(process.argv.slice(2)));
}
