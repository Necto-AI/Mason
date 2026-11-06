/**
 * A stack comes back after a reboot with nobody at the keyboard, and the two halves of that are pinned here.
 *
 * `restart: unless-stopped` is not a boot policy: podman records a shutdown as an explicit stop, and a container somebody
 * stopped is one that policy declines to start, so a reboot left both stacks down for six hours (#86). The policy is
 * `restart: always` on every service, plus `podman-restart.service` enabled in the operator's own systemd session, which
 * is the half no compose file can carry. A stack that loses either half keeps a lifecycle that ends at the next reboot,
 * and nothing in the log says so: it looks like a bot with nothing to say.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../", import.meta.url).pathname;

const read = (path: string) => readFile(join(root, path), "utf8");

/** A compose file, and the services it starts. `compose.telegram.yaml` is a second file of the same project. */
const COMPOSE_FILES = ["deploy/compose.yaml", "deploy/compose.telegram.yaml"];

interface Service {
	name: string;
	restart?: string;
}

/**
 * The services of one compose file, each with the restart policy its own keys declare.
 *
 * Read from the text rather than from a parsed model, and comments are skipped: the integration template at the end of
 * `compose.yaml` is commented out, so it is not a service here and its own example line is not a claim this file makes.
 */
function services(text: string): Service[] {
	const found: Service[] = [];
	let section = "";
	let service: Service | undefined;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const top = /^([A-Za-z][\w-]*):\s*$/.exec(line);
		if (top) {
			section = top[1];
			service = undefined;
			continue;
		}
		if (section !== "services") continue;
		const opening = /^ {2}([A-Za-z][\w.-]*):\s*$/.exec(line);
		if (opening) {
			service = { name: opening[1] };
			found.push(service);
			continue;
		}
		const restart = /^ {4}restart:\s*(\S+)\s*$/.exec(line);
		if (restart && service) service.restart = restart[1];
	}
	return found;
}

for (const file of COMPOSE_FILES) {
	test(`every service in ${file} is restored at boot`, async () => {
		const text = await read(file);
		const declared = services(text);
		assert.ok(declared.length > 0, `${file} starts at least one service`);
		for (const service of declared) {
			assert.equal(service.restart, "always", `${service.name} declares restart: always`);
		}
		// The one line somebody reaches for when a container "keeps restarting", and the one that does not survive a reboot.
		const stopped = text
			.split("\n")
			.filter((line) => !line.trim().startsWith("#"))
			.filter((line) => /restart:\s*unless-stopped/.test(line));
		assert.deepEqual(stopped, [], `${file} carries no unless-stopped policy`);
	});
}

test("the README names the boot policy, and the two commands that turn it on", async () => {
	const readme = await read("deploy/README.md");
	const headings = [...readme.matchAll(/^## (.+)$/gm)].map((match) => ({ title: match[1], at: match.index ?? 0 }));
	const policy = headings.findIndex((heading) => heading.title === "A reboot is not a stop");
	assert.ok(policy > 0, "deploy/README.md has the section an operator reads after a reboot");
	// Next to the second-stack section, because a second stack is what a boot unit restores beside the first one.
	assert.equal(headings[policy - 1].title, "Two bots on one host", "it sits beside Two bots on one host");
	const section = readme.slice(headings[policy].at, headings[policy + 1]?.at ?? readme.length);
	assert.match(section, /restart: always/, "it names the policy the compose files declare");
	assert.match(section, /systemctl --user enable --now podman-restart\.service/, "and the unit that restores them");
	assert.match(section, /loginctl enable-linger/, "and lingering, without which that unit never starts at boot");
});

test("a stack that is already running takes the policy on from the next deploy", async () => {
	const script = await read("deploy/deploy.sh");
	// Recreation is what carries a compose-declared `restart` policy onto containers that were created without it.
	assert.match(
		script,
		/up -d --force-recreate/,
		"deploy.sh recreates every container, so the policy in the compose file is the one they carry",
	);
});
