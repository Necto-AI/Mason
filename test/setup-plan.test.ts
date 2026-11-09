/**
 * `src/setup/plan.ts` — the decision, as a value.
 *
 * Every test here calls a planner against a temporary home and then asserts two things about it: what it decided, and
 * that the home is exactly as it was. That second half is the point of the seam — a planner that writes is a preview
 * that runs — and the credential it issues is injected, so "two plans from the same answers are equal" is a fact and not
 * a hope about randomness.
 *
 * No podman, no network, no terminal: a planner reads files and returns a value.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { CONSOLE, CONSOLE_DESCRIPTION, consoleGrant } from "../scripts/chat.ts";
import { catalogEntry } from "../src/server/catalog.ts";
import { composePath, projectName } from "../src/server/connector-compose.ts";
import type { ConnectorCredential } from "../src/server/connectors.ts";
import { housePaths } from "../src/server/house.ts";
import { readInstalls } from "../src/server/install-state.ts";
import { writeIntegration } from "../src/server/integrations.ts";
import {
	type ConnectorAnswers,
	type MintCredential,
	type MintedCredential,
	masonPort,
	planConnector,
} from "../src/setup/plan.ts";

const homes: string[] = [];
after(async () => {
	for (const home of homes) await rm(home, { recursive: true, force: true });
});

/** A home nothing has written to: the state a first `mason setup` finds the directory in. */
async function emptyHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "mason-plan-"));
	homes.push(home);
	return home;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** A mint that always answers the same thing, which is what makes two plans comparable. */
function fixedMint(plaintext = "masonc_fixed_credential", id = "con_fixed"): MintCredential {
	return (connector: string): MintedCredential => ({
		plaintext,
		record: { id, connector, sha256: sha256(plaintext), createdAt: "2026-01-01T00:00:00.000Z" },
	});
}

/** The answers a `--yes` run of telegram gives, with no terminal anywhere. */
const telegram: ConnectorAnswers = {
	kind: "catalog",
	name: "telegram",
	env: { TELEGRAM_BOT_TOKEN: "123:fake", TELEGRAM_ALLOWED_CHATS: "8811" },
	owner: "8811",
};

describe("a catalog connector", () => {
	test("plans the grant, the source and the project, and writes nothing", async () => {
		const home = await emptyHome();
		const paths = housePaths(home);
		const entry = await catalogEntry("telegram");

		const plan = await planConnector(telegram, paths, { mint: fixedMint() });

		assert.equal(plan.name, "telegram");
		assert.equal(plan.source, `catalog:telegram@${entry.version}`);
		assert.equal(plan.image, `${entry.image}:${entry.version}`);
		assert.equal(plan.version, entry.version);
		// The chats the entry's answers named become the grant's targets, with the chat id as the label.
		assert.deepEqual(plan.grant.targets, [
			{ id: "8811", label: "8811", capabilities: [...entry.connector.capabilities] },
		]);
		assert.deepEqual(plan.grant.user, { owner: "8811", capabilities: [...entry.connector.capabilities] });
		assert.deepEqual(plan.grant.commands, [...entry.connector.commands]);
		// The entry is the one the boot will read: enabled, described, and granted.
		assert.equal(plan.entry?.enabled, true);
		assert.equal(plan.entry?.description, entry.description);
		assert.deepEqual(plan.entry?.connector, plan.grant);
		// Nothing about this home exists yet, so both halves of the record are empty.
		assert.equal(plan.held, undefined);
		assert.equal(plan.previous, undefined);
		assert.deepEqual(plan.credential, {
			plaintext: "masonc_fixed_credential",
			replace: false,
			record: {
				id: "con_fixed",
				connector: "telegram",
				sha256: sha256("masonc_fixed_credential"),
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		});

		// One file, and the project it belongs to: the compose file, carrying the wiring and the credential.
		assert.deepEqual(plan.project, {
			composeFile: composePath(paths, "telegram"),
			name: projectName(home, "telegram"),
		});
		assert.equal(plan.writes.length, 1);
		const write = plan.writes[0];
		assert.equal(write?.path, composePath(paths, "telegram"));
		assert.match(write?.text ?? "", new RegExp(`^name: ${projectName(home, "telegram")}$`, "m"));
		assert.match(write?.text ?? "", new RegExp(`ws://host\\.containers\\.internal:${masonPort()}/api/connector`));
		assert.match(write?.text ?? "", /MASON_CONNECTOR_CREDENTIAL: "masonc_fixed_credential"/);
		assert.match(write?.text ?? "", /TELEGRAM_ALLOWED_CHATS: "8811"/);

		// And the home is untouched: no home directory created, no store, no project, no lock.
		assert.deepEqual(await readdir(home), []);
	});

	test("two calls with the same answers and the same mint are equal", async () => {
		const home = await emptyHome();
		const first = await planConnector(telegram, housePaths(home), { mint: fixedMint() });
		const second = await planConnector(telegram, housePaths(home), { mint: fixedMint() });
		assert.deepEqual(second, first);
		// The default mint is randomness, so it is the one thing that must differ between two runs.
		const random = await planConnector(telegram, housePaths(home));
		assert.notEqual(random.credential?.record.sha256, first.credential?.record.sha256);
	});

	test("a home that already grants it plans no entry, and mints nothing", async () => {
		const home = await emptyHome();
		const paths = housePaths(home);
		const granted = await planConnector(telegram, paths, { mint: fixedMint() });
		await writeIntegration(paths, "telegram", granted.entry ?? assert.fail("no entry to write"));
		await mkdir(join(home, "service"), { recursive: true });
		const record: ConnectorCredential = {
			id: "con_held",
			connector: "telegram",
			sha256: sha256("masonc_held"),
			createdAt: "2026-01-02T00:00:00.000Z",
		};
		await writeFile(paths.config, JSON.stringify({ version: "0.1", connectors: [record] }));
		// The project a previous run rendered, with the plaintext the record above holds the hash of.
		await mkdir(join(paths.connectorsDir, "telegram"), { recursive: true });
		await writeFile(
			composePath(paths, "telegram"),
			`services:\n  telegram:\n    environment:\n      MASON_CONNECTOR_CREDENTIAL: "masonc_held"\n`,
		);

		const plan = await planConnector(telegram, paths, { mint: fixedMint() });

		assert.equal(plan.entry, undefined, "a grant that is there is added to, never rewritten");
		assert.equal(plan.credential, undefined, "the credential the home holds is reused, not minted again");
		assert.deepEqual(plan.held, record);
		assert.match(plan.writes[0]?.text ?? "", /MASON_CONNECTOR_CREDENTIAL: "masonc_held"/);
	});

	test("a project whose plaintext the home no longer holds is a rotation", async () => {
		const home = await emptyHome();
		const paths = housePaths(home);
		await mkdir(join(home, "service"), { recursive: true });
		await writeFile(
			paths.config,
			JSON.stringify({
				version: "0.1",
				connectors: [
					{ id: "con_held", connector: "telegram", sha256: sha256("masonc_held"), createdAt: "2026-01-02" },
				],
			}),
		);
		// No compose file: the plaintext the container was given is gone, and the hash is all that is left.
		const plan = await planConnector(telegram, paths, { mint: fixedMint("masonc_rotated", "con_rotated") });
		assert.equal(plan.credential?.replace, true);
		assert.equal(plan.credential?.record.id, "con_rotated");
		assert.match(plan.writes[0]?.text ?? "", /MASON_CONNECTOR_CREDENTIAL: "masonc_rotated"/);
	});
});

describe("a connector already running somewhere else", () => {
	const url = "ws://127.0.0.1:9999/api/connector";

	test("plans a grant with the owner as its one target when none was named", async () => {
		const home = await emptyHome();
		const plan = await planConnector(
			{ kind: "url", name: "custom", url, owner: "denis", targets: [], events: {} },
			housePaths(home),
			{ mint: fixedMint() },
		);
		assert.equal(plan.source, `url:${url}`);
		assert.equal(plan.image, undefined, "nothing is pulled for a connector mason does not run");
		assert.deepEqual(plan.grant.targets, [{ id: "denis", label: "denis", capabilities: ["text", "markdown"] }]);
		assert.equal(plan.grant.events, undefined);
		assert.deepEqual(plan.writes, [], "no container, no project, no file");
		assert.equal(plan.project, undefined);
	});

	test("plans the targets and the event hooks it was given", async () => {
		const home = await emptyHome();
		await mkdir(join(home, "agent"), { recursive: true });
		await writeFile(
			join(home, "agent", "routines.json"),
			JSON.stringify([{ name: "check-mail", intervalSeconds: 600, prompt: "Read the mail." }]),
		);
		const plan = await planConnector(
			{
				kind: "url",
				name: "custom",
				url,
				owner: "denis",
				targets: ["denis", "-100200"],
				events: { mail: "check-mail" },
			},
			housePaths(home),
			{ mint: fixedMint() },
		);
		assert.deepEqual(
			plan.grant.targets?.map((target) => [target.id, target.label]),
			[
				["denis", "denis"],
				["100200", "-100200"],
			],
		);
		assert.deepEqual(plan.grant.events, { hooks: { mail: "check-mail" } });
	});
});

describe("the connector whose grant is fixed in code", () => {
	test("plans the console's grant, its own address, and no file at all", async () => {
		const home = await emptyHome();
		const plan = await planConnector(
			{
				kind: "fixed",
				name: CONSOLE,
				description: CONSOLE_DESCRIPTION,
				grant: consoleGrant(),
				source: `url:ws://127.0.0.1:${masonPort()}/api/connector`,
			},
			housePaths(home),
			{ mint: fixedMint() },
		);
		assert.deepEqual(plan.grant, consoleGrant());
		assert.equal(plan.description, CONSOLE_DESCRIPTION);
		assert.match(plan.source, /^url:ws:\/\/127\.0\.0\.1:\d+\/api\/connector$/);
		assert.deepEqual(plan.writes, []);
		assert.equal(plan.project, undefined);
		assert.equal(plan.credential?.replace, false, "the console has no project, and still gets its first credential");
	});
});

describe("a plan refuses what it can see is wrong, before anything is written", () => {
	test("a url that is not a socket", async () => {
		const home = await emptyHome();
		await assert.rejects(
			planConnector(
				{ kind: "url", name: "custom", url: "http://127.0.0.1:9999", owner: "denis", targets: [], events: {} },
				housePaths(home),
				{ mint: fixedMint() },
			),
			/not a WebSocket URL/,
		);
		assert.deepEqual(await readdir(home), []);
	});

	test("an event kind that fires a hook no build defines", async () => {
		const home = await emptyHome();
		await assert.rejects(
			planConnector(
				{
					kind: "url",
					name: "custom",
					url: "ws://127.0.0.1:9999/api/connector",
					owner: "denis",
					targets: [],
					events: { mail: "check-mail" },
				},
				housePaths(home),
				{ mint: fixedMint() },
			),
			/the kind "mail" fires "check-mail", which is not a hook/,
		);
		assert.deepEqual(await readdir(home), []);
	});

	test("a name the catalog does not ship", async () => {
		const home = await emptyHome();
		await assert.rejects(
			planConnector({ kind: "catalog", name: "npm-slack", env: {}, owner: "denis" }, housePaths(home), {
				mint: fixedMint(),
			}),
			/there is no connector "npm-slack"/,
		);
	});
});

describe("a plan is about one home and reads the one it is given", () => {
	test("it reports the install record a second run keeps", async () => {
		const home = await emptyHome();
		const paths = housePaths(home);
		await mkdir(join(home, "service"), { recursive: true });
		await writeFile(
			paths.connectors,
			JSON.stringify({
				connectors: {
					telegram: {
						source: "catalog:telegram@0.2.0",
						createdAt: "2026-01-01T00:00:00.000Z",
						started: false,
					},
				},
			}),
		);
		const plan = await planConnector(telegram, paths, { mint: fixedMint() });
		const { connectors } = await readInstalls(paths);
		assert.deepEqual(plan.previous, connectors.telegram);
	});
});
