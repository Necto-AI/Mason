/**
 * `mason bots` — the bots under the root, and which one a command would target.
 *
 * Listing is the answer to the refusal `resolveBot` prints when a root holds several: a person who was told "alice, bob"
 * needs to see where each one lives before they pick. The marker is the same resolution every other verb uses, so the
 * line that says `(current)` is the line that says what `mason up` would serve — not a second opinion about targeting.
 */
import { readRoot, refuseHomeEnv, resolveBot, rootPath, takeBot } from "../src/server/root.ts";

export function usage(): string {
	return `usage: mason bots

  Every bot under the root (MASON_ROOT, else ~/.mason), its home, and which one a command targets now: -b, else MASON_BOT,
  else the only bot. A root with several bots and no target refuses with this list.`;
}

export function runBots(argv: readonly string[]): number {
	try {
		const args = takeBot(argv);
		if (args.includes("--help") || args.includes("-h")) {
			console.log(usage());
			return 0;
		}
		refuseHomeEnv();
		const root = readRoot(rootPath());
		if (root.bots.length === 0) {
			console.log(`no bots under ${root.root}: \`mason onboard\` creates the first one`);
			return 0;
		}
		let current: string | undefined;
		try {
			current = resolveBot(root).name;
		} catch {
			// Several bots and no target: the list is still the answer, and the refusal that names them is one command away.
			current = undefined;
		}
		for (const bot of root.bots) console.log(`${bot.name}\t${bot.home}${bot.name === current ? "\t(current)" : ""}`);
		return 0;
	} catch (error) {
		console.error(`[bots] ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	process.exit(runBots(process.argv.slice(2)));
}
