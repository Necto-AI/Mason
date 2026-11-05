/**
 * `npm run doctor -- migrate` — the one command that moves a home from before the split into its two halves.
 *
 * The home is a directory Denis can read and diff, so the upgrade is a command he can read and run twice, not a
 * file shuffle he has to reason about. It moves the known entries into their halves, freezes the pre-split repository
 * where it stands (both halves leave its index and enter its `.gitignore`) and creates the agent's own repository with
 * one commit — so the layout change is something he can inspect and revert like any other.
 *
 * It also finishes the configuration a cutover needs: a credential written before grants existed is stamped, an entry
 * that still carries the signed event door's `trigger` (and the `commands` list that belonged to it) has both keys
 * removed — the door is gone (#104), and a boot refuses a file that still names it rather than reading past a secret
 * nothing checks — and a connector whose user face still carries an actor map, an `unattributed` switch or a named
 * approver is rewritten to the one `owner` mason now admits, with `service/roster.json` printed and deleted (#126).
 *
 * `doctor` rather than a command of its own because this is what it is: a check on the home that repairs it when asked.
 * Nothing here runs on boot. A server that moved files on start would be a server that edits the operator's home.
 */
import { migrateTokenGrants } from "../src/server/auth.ts";
import { cutOverSingleUser } from "../src/server/cutover.ts";
import { currentHouse, migrateHouse } from "../src/server/house.ts";
import { migrateIntegrationTriggers } from "../src/server/integrations.ts";

const [command] = process.argv.slice(2);
const house = currentHouse();

function usage(): never {
	console.log(`usage:
  npm run doctor -- migrate

  home: ${house.home}
  agent half:   ${house.agentDir}   (mounted into the tool machine)
  service half: ${house.serviceDir}   (never a path inside the tool machine)

  migrate moves an existing home into those two halves, once. It is safe to run twice, and a second run finishes what an
  interrupted one left (the agent's first commit, the freeze of the repository at the root) when it is missing. The
  repository at the home root stays where it is and is frozen; the agent's history starts fresh in agent/.git. It refuses
  when the same entry is in the root and in a half that already holds something, and when agent/.git already holds paths
  from service/ — a history from before this fix, which it names the repair for instead of touching.

  It also finishes the configuration the panel and the connector door need: a credential written before grants existed
  is stamped with conversation, admin and approve — what the console it replaced could do, and not trace — and an entry
  that still carries the old signed event door's "trigger" (with the "commands" list that belonged to it) loses both,
  because that door is gone (#104). A credential that already has grants is left alone, so a narrowed device stays
  narrowed. A connector whose user face still maps actors to names is rewritten to the one owner it had, which is a
  refusal when it mapped several: which of them this bot works for is the operator's call. service/roster.json is
  printed and deleted, because nothing reads it any more. None of this is done on boot: a server that rewrote the
  operator's files on start would be a server that edits his home.`);
	process.exit(command === undefined || command === "--help" ? 0 : 1);
}

if (command !== "migrate") usage();

const outcome = await migrateHouse(house);
if (outcome.status === "refused") {
	console.error(`[doctor] ${outcome.reason}`);
	process.exit(1);
}
const migrated = await migrateIntegrationTriggers(house);
for (const entry of migrated) {
	console.log(`[doctor] ${entry.name}: removed the signed event door's trigger face`);
	if (entry.moved.length > 0) {
		console.log(
			`[doctor] ${entry.name}: its control vocabulary moved to connector.commands: ${entry.moved.join(", ")}`,
		);
	}
	if (entry.stranded.length > 0) {
		console.log(
			`[doctor] ${entry.name}: it declared ${entry.stranded.join(", ")} with no connector block to hold them, so ` +
				"they are gone — grant them there (`connector.commands`) when the connector has one",
		);
	}
}
const cutover = await cutOverSingleUser(house).catch((error: unknown) => {
	console.error(`[doctor] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
for (const entry of cutover.integrations) {
	console.log(
		`[doctor] ${entry.name}: removed ${entry.retired.join(", ")} from connector.user, and it is ` +
			`${entry.owner === undefined ? "no owner: an actorless submission is still accepted, an actor is refused" : `owned by actor ${entry.owner}`}`,
	);
}
if (cutover.roster !== undefined) {
	console.log(
		`[doctor] deleted service/roster.json: it held ${cutover.roster.length === 0 ? "no names" : cutover.roster.join(", ")}` +
			". Who this bot works for is agent/profile.md",
	);
}
const granted = await migrateTokenGrants(house.home);
for (const record of granted) {
	console.log(
		`[doctor] ${record.id} (${record.label}) had no grants: stamped conversation, admin, approve. ` +
			`Narrow it with: npm run token -- grants ${record.id} conversation`,
	);
}
if (outcome.status === "unchanged") {
	console.log(
		outcome.finished.length === 0
			? `[doctor] nothing to move: ${house.home} is already split into agent/ and service/`
			: `[doctor] nothing to move; finished what an interrupted run left: ${outcome.finished.join("; ")}`,
	);
	process.exit(0);
}
for (const move of outcome.moves) console.log(`[doctor] ${move.from} -> ${move.to}`);
console.log(
	outcome.committed
		? `[doctor] moved ${outcome.moves.length} entr${outcome.moves.length === 1 ? "y" : "ies"} and froze the repository at ${house.home}`
		: `[doctor] moved ${outcome.moves.length} entr${outcome.moves.length === 1 ? "y" : "ies"}, but nothing was committed in ${house.home}: it is not a repository, or git refused the commit`,
);
console.log(`[doctor] the agent's history starts in ${house.agentDir}/.git; ${house.serviceDir}/ is unversioned`);
console.log(
	`[doctor] the pre-split history stays in ${house.home}/.git, on this machine — it is never a path inside the tool machine`,
);
