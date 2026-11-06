/**
 * `src/server/connector-compose.ts` — the project one installed connector runs in.
 *
 * What is pinned is the file a container is started from, byte for byte, because every field in it is a policy someone
 * decided: `always` and not `unless-stopped` is the policy that brings the bot back when the machine reboots — the
 * systemd half of that is `podman.test.ts` — the project name is what keeps two homes on one host apart, and the absent
 * `ports:` is the promise that a connector adds no way in.
 * A test that asserted "the image appears somewhere" would pass on a file podman refuses.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { catalogEntry } from "../src/server/catalog.ts";
import {
	composePath,
	homeId,
	projectName,
	readComposeCredential,
	renderCompose,
	writeCompose,
} from "../src/server/connector-compose.ts";
import { housePaths } from "../src/server/house.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function temporaryHome(): Promise<ReturnType<typeof housePaths>> {
	const directory = await mkdtemp(join(tmpdir(), "mason-compose-"));
	directories.add(directory);
	return housePaths(join(directory, "house"));
}

/** The options setup builds for one catalog entry: the image with its tag, the wiring, then the answers. */
async function telegramOptions(home: string): Promise<Parameters<typeof renderCompose>[0]> {
	const entry = await catalogEntry("telegram");
	return {
		connector: entry.name,
		image: `${entry.image}:${entry.version}`,
		home,
		env: {
			MASON_CONNECTOR_URL: "ws://host.containers.internal:8787/api/connector",
			MASON_CONNECTOR_CREDENTIAL: "masonc_fakecredential",
			TELEGRAM_BOT_TOKEN: "123456:fake-token",
			TELEGRAM_ALLOWED_CHATS: "8811,@denis",
		},
	};
}

describe("the rendered project", () => {
	test("the telegram entry, byte for byte", async () => {
		const home = "/home/someone/.mason";
		const rendered = renderCompose(await telegramOptions(home));
		assert.equal(
			rendered,
			`# Rendered by \`mason setup\`. Editing this file is fine; \`mason setup\` will overwrite it.
name: ${homeId(home)}-telegram
services:
  telegram:
    image: "ghcr.io/denissud/mason-telegram:0.2.0"
    restart: always
    environment:
      MASON_CONNECTOR_URL: "ws://host.containers.internal:8787/api/connector"
      MASON_CONNECTOR_CREDENTIAL: "masonc_fakecredential"
      TELEGRAM_BOT_TOKEN: "123456:fake-token"
      TELEGRAM_ALLOWED_CHATS: "8811,@denis"
    extra_hosts:
      - "host.containers.internal:host-gateway"
`,
		);
	});

	test("comes back after a reboot, and asks for nothing that is not there", async () => {
		const rendered = renderCompose(await telegramOptions("/home/someone/.mason"));
		assert.match(rendered, /^ {4}restart: always$/m, "unless-stopped is a stop once the machine goes down");
		assert.doesNotMatch(rendered, /unless-stopped/);
		// The env the person did not answer is absent, not empty: `HTTPS_PROXY=` would send Telegram's API through no
		// proxy at all on a host that needed one, and an empty variable is not the same as an unset one to undici.
		assert.doesNotMatch(rendered, /HTTPS_PROXY/);
	});

	test("publishes no port: the connector dials out and nothing dials in", async () => {
		const rendered = renderCompose(await telegramOptions("/home/someone/.mason"));
		assert.doesNotMatch(rendered, /ports:/);
		assert.deepEqual(
			[...rendered.matchAll(/host\.containers\.internal:(\d+)/g)].map((match) => match[1]),
			["8787"],
			"the one address it reaches is mason's connector port",
		);
	});

	test("two homes on one host do not collide", () => {
		assert.notEqual(projectName("/home/a/.mason", "telegram"), projectName("/home/b/.mason", "telegram"));
		// The same home, spelled two ways, is one project: the name is what `podman compose -p` takes.
		assert.equal(homeId("/home/a/x/../.mason"), homeId("/home/a/.mason"));
		assert.match(projectName("/home/a/.mason", "telegram"), /^[0-9a-f]{8}-telegram$/);
	});

	test("a value that would end the YAML string early is escaped, not split", async () => {
		const options = await telegramOptions("/home/someone/.mason");
		const rendered = renderCompose({
			...options,
			env: { ...options.env, TELEGRAM_ALLOWED_CHATS: '8811,"quoted"\\path' },
		});
		assert.match(rendered, /TELEGRAM_ALLOWED_CHATS: "8811,\\"quoted\\"\\\\path"/);
	});

	test("a name a container cannot carry is a refusal, not a broken file", async () => {
		const options = await telegramOptions("/home/someone/.mason");
		assert.throws(() => renderCompose({ ...options, env: { "NOT A NAME": "x" } }), /not an environment name/);
		assert.throws(() => renderCompose({ ...options, connector: "Telegram" }), /not a connector name/);
	});
});

describe("the file on disk", () => {
	test("is written beside the grant, private, and names the connector's project", async () => {
		const paths = await temporaryHome();
		const written = await writeCompose(paths, await telegramOptions(paths.home));
		assert.equal(written.path, composePath(paths, "telegram"));
		assert.equal(written.path, join(paths.connectorsDir, "telegram", "compose.yaml"));
		assert.equal(written.project, projectName(paths.home, "telegram"));
		assert.equal((await stat(written.path)).mode & 0o777, 0o600, "it carries the credential");
		assert.match(await readFile(written.path, "utf8"), /restart: always/);
	});

	test("a second render of the same project leaves the file where it was", async () => {
		const paths = await temporaryHome();
		const options = await telegramOptions(paths.home);
		const first = await writeCompose(paths, options);
		const before = (await stat(first.path)).mtimeMs;
		await writeCompose(paths, options);
		assert.equal((await stat(first.path)).mtimeMs, before, "an unchanged project is not rewritten");
	});

	test("the credential it was rendered with is readable back, escapes included", async () => {
		const paths = await temporaryHome();
		const options = await telegramOptions(paths.home);
		const written = await writeCompose(paths, {
			...options,
			env: { ...options.env, MASON_CONNECTOR_CREDENTIAL: 'masonc_a"b\\c' },
		});
		assert.equal(await readComposeCredential(written.path), 'masonc_a"b\\c');
		assert.equal(await readComposeCredential(join(paths.connectorsDir, "absent", "compose.yaml")), undefined);
	});

	test("reports whether it wrote, rewrote or found the project already right", async () => {
		const paths = await temporaryHome();
		const options = await telegramOptions(paths.home);
		const first = await writeCompose(paths, options);
		assert.deepEqual([first.changed, first.created], [true, true]);
		const again = await writeCompose(paths, options);
		assert.deepEqual([again.changed, again.created], [false, false]);
		// A rotated credential, or a version that moved: the file has to carry the new answer, because the container it
		// starts reads nothing else.
		const moved = await writeCompose(paths, { ...options, image: "ghcr.io/denissud/mason-telegram:0.3.0" });
		assert.deepEqual([moved.changed, moved.created], [true, false]);
		assert.match(await readFile(moved.path, "utf8"), /mason-telegram:0\.3\.0/);
	});
});
