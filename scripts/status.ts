/**
 * `mason status` — one line: which bot, which model, how much is configured, and whether mason is up.
 *
 * The quick half of the doctor, for the moment between "I changed something" and "did it take". It reads the same files
 * and asks the same port, and it writes nothing: a status that changed state would be a status nobody runs twice.
 *
 * The model line follows the same precedence as the boot (`common.ts`), so the line cannot disagree with what a turn
 * would actually run. It never prints a key, because a status line ends up in a paste.
 */
import { readPiSettingsModel, resolveModelChoice } from "../src/server/common.ts";
import { botPaths } from "../src/server/house.ts";
import { type Integration, readIntegrations } from "../src/server/integrations.ts";
import { listening } from "../src/server/podman.ts";
import { readRoot, resolveBot, rootPath } from "../src/server/root.ts";

export function usage(): string {
	return `usage: mason status

  One line about the targeted bot: its name and home, the provider and model it would run, how many integrations and
  connectors are configured, and whether mason is listening. -b <name> or MASON_BOT picks the bot.`;
}

export async function runStatus(argv: readonly string[]): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(usage());
		return 0;
	}
	try {
		const root = readRoot(rootPath());
		const target = resolveBot(root);
		const house = botPaths(target);
		const choice = await resolveModelChoice(house);
		const fallback = choice === undefined ? readPiSettingsModel() : undefined;
		const model =
			choice === undefined
				? fallback === undefined
					? "none"
					: `${fallback.provider}/${fallback.modelId} (pi's settings.json)`
				: `${choice.provider}/${choice.modelId}`;
		const integrations: Record<string, Integration | undefined> = await readIntegrations(house)
			.then((read) => read.integrations)
			.catch(() => ({}));
		const names = Object.keys(integrations);
		const connectors = names.filter((name) => integrations[name]?.connector !== undefined).length;
		const port = Number(process.env.PORT ?? 8787);
		const up = await listening("127.0.0.1", port);
		console.log(
			`bot ${target.name} (${house.home}): model ${model}; ${names.length} integration${names.length === 1 ? "" : "s"}, ` +
				`${connectors} connector${connectors === 1 ? "" : "s"}; mason ${up ? `listening on ${port}` : "not running"}`,
		);
		return 0;
	} catch (error) {
		console.error(`[status] ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await runStatus(process.argv.slice(2)));
}
