/**
 * `npm run team -- <add|remove|list> …` — who is in the room.
 *
 * The roster (`src/server/roster.ts`) is the list of names a browser can claim on the join screen; this is the command
 * that fills it, so onboarding a teammate is one line rather than a hand-edited JSON file. It deliberately does not
 * mint tokens: a person and a device are two different things, and pairing a browser is still `npm run token`.
 *
 * The server reads the file per request, so an add or a remove lands on the next request without a restart — which is
 * the moment that matters, because a removal is how someone stops being able to speak.
 */
import { housePaths } from "../src/server/house.ts";
import { addPerson, findPerson, readRoster, removePerson } from "../src/server/roster.ts";
import { NAME_MAX } from "../src/shared/contract.ts";

const [command, ...args] = process.argv.slice(2);
const house = housePaths();

function usage(): never {
	console.log(`usage:
  npm run team -- list
  npm run team -- add "Ilya"
  npm run team -- remove "Ilya"

  home: ${house.home}
  a name is a label, not a password: any paired browser may claim any name on the roster.
  a running server reads the roster per request: an add or a remove is live, without a restart.`);
	process.exit(command === undefined || command === "--help" ? 0 : 1);
}

if (command === "list") {
	const roster = await readRoster(house);
	if (roster.people.length === 0) {
		console.log(`no one is on the roster yet: add the first person with: npm run team -- add "Ilya"`);
	}
	for (const person of roster.people) {
		console.log(`${person.name.padEnd(24)}  added ${person.addedAt}`);
	}
} else if (command === "add") {
	const name = args[0];
	if (name === undefined) usage();
	const result = await addPerson(house, name);
	if (!result.ok) {
		console.error(
			result.reason === "duplicate"
				? `"${name}" is already on the roster: one person, one spelling`
				: `"${name}" is not a name a message can carry: no brackets, no control characters, at most ${NAME_MAX} characters`,
		);
		process.exit(1);
	}
	console.log(`added "${result.person.name}"`);
	console.log("They can claim it on /join in their browser now: nothing to mint, and no restart.");
} else if (command === "remove") {
	const name = args[0];
	if (name === undefined) usage();
	// The roster's spelling, not the typed one: what is printed should be the name the transcript carries.
	const person = findPerson(await readRoster(house), name);
	if (person === undefined) {
		console.error(`no such person on the roster: ${name}`);
		process.exit(1);
	}
	await removePerson(house, person.name);
	console.log(`removed "${person.name}"`);
	console.log("Their next request is refused and their next connection does not open.");
} else {
	usage();
}
