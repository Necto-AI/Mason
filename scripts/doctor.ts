/**
 * `npm run doctor -- migrate` — the one command that moves a home from before the split into its two halves.
 *
 * The home is a directory Denis can read and diff, so the upgrade is a command he can read and run twice, not a
 * file shuffle he has to reason about. It moves the known entries with `git mv` inside the home's own repository and
 * records the result as two commits — the move, then the service half leaving the repository — so the layout change is
 * something he can inspect and revert like any other.
 *
 * `doctor` rather than a command of its own because this is what it is: a check on the home that repairs it when asked.
 * Nothing here runs on boot. A server that moved files on start would be a server that edits the operator's home.
 */
import { currentHouse, migrateHouse } from "../src/server/house.ts";

const [command] = process.argv.slice(2);
const house = currentHouse();

function usage(): never {
	console.log(`usage:
  npm run doctor -- migrate

  home: ${house.home}
  agent half:   ${house.agentDir}   (mounted into the tool machine)
  service half: ${house.serviceDir}   (never a path inside the tool machine)

  migrate moves an existing home into those two halves, once, and commits it in the home's own repository.
  It is safe to run twice, and it refuses when the same entry is in both halves at once.`);
	process.exit(command === undefined || command === "--help" ? 0 : 1);
}

if (command !== "migrate") usage();

const outcome = await migrateHouse(house);
if (outcome.status === "refused") {
	console.error(`[doctor] ${outcome.reason}`);
	process.exit(1);
}
if (outcome.status === "unchanged") {
	console.log(`[doctor] nothing to move: ${house.home} is already split into agent/ and service/`);
	process.exit(0);
}
for (const move of outcome.moves) console.log(`[doctor] ${move.from} -> ${move.to}`);
console.log(
	outcome.committed
		? `[doctor] moved ${outcome.moves.length} entr${outcome.moves.length === 1 ? "y" : "ies"} and committed the move`
		: `[doctor] moved ${outcome.moves.length} entr${outcome.moves.length === 1 ? "y" : "ies"}; ${house.home} is not a git repository, so nothing was committed`,
);
console.log(`[doctor] the agent's history now lives in ${house.agentDir}/.git; ${house.serviceDir}/ is unversioned`);
