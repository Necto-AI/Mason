/**
 * `service/connectors.json` and its grammar (`src/server/install-state.ts`).
 *
 * What is pinned is the boundary the file exists on. It records what `mason setup` did, and the server does not read it:
 * a record for a connector whose grant was never written must leave a boot exactly as it was, while a record for a
 * connector that was installed must survive a second install of a different one. The rest is the source grammar, which
 * is fixed in this release and only half implemented on purpose — `npm:` and `git:` have to parse today so that a file
 * written now is a file 0.1.1 can start, and refusing them has to say so rather than look like a typo.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { housePaths } from "../src/server/house.ts";
import {
	type ConnectorInstall,
	parseSource,
	readInstalls,
	removeInstall,
	requireInstallable,
	writeInstall,
} from "../src/server/install-state.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function temporaryHome(): Promise<ReturnType<typeof housePaths>> {
	const directory = await mkdtemp(join(tmpdir(), "mason-install-state-"));
	directories.add(directory);
	const paths = housePaths(join(directory, "house"));
	// The half the file lives in: setup creates it with `ensureHouse`, and a test that wrote the file by hand without
	// it would be proving the writer, not the reader.
	await mkdir(paths.serviceDir, { recursive: true, mode: 0o700 });
	return paths;
}

function record(source: string, overrides: Partial<ConnectorInstall> = {}): ConnectorInstall {
	return { source, project: "a1b2c3d4-telegram", createdAt: "2026-11-06T00:00:00.000Z", started: false, ...overrides };
}

describe("the source grammar", () => {
	test("reads the four forms, and keeps a version on the ones mason starts", () => {
		assert.deepEqual(parseSource("catalog:telegram@0.2.0"), {
			kind: "catalog",
			name: "telegram",
			version: "0.2.0",
		});
		assert.deepEqual(parseSource("url:wss://connector.example/mason"), {
			kind: "url",
			url: "wss://connector.example/mason",
		});
		// The scope's own `@` is not the version separator: the last one is.
		assert.deepEqual(parseSource("npm:@denissud/mason-telegram@0.3.0"), {
			kind: "npm",
			package: "@denissud/mason-telegram",
			version: "0.3.0",
		});
		assert.deepEqual(parseSource("git:github.com/DenisSud/mason-slack@v1"), {
			kind: "git",
			host: "github.com",
			repo: "DenisSud/mason-slack",
			ref: "v1",
		});
	});

	test("refuses a source mason does not read, and lists the four it does", () => {
		assert.throws(() => parseSource("docker:ghcr.io/x"), /is not a source mason reads.*catalog:/s);
		assert.throws(() => parseSource(""), /is not a source mason reads/);
	});

	test("a connector mason starts has to be pinnable, and a url does not", () => {
		assert.throws(() => parseSource("catalog:telegram"), /names no version/);
		assert.throws(() => parseSource("npm:@scope/pkg"), /names no version/);
		assert.throws(() => parseSource("catalog:Telegram@1"), /not lowercase letters, digits and dashes/);
		assert.throws(() => parseSource("url:http://127.0.0.1:8082"), /not a WebSocket URL/);
		assert.throws(() => parseSource("url:not a url"), /is not a URL/);
		assert.throws(() => parseSource("git:github.com@v1"), /is not <host>\/<owner>\/<repo>/);
	});

	test("the install path lands in 0.1.1, and says so rather than looking broken", () => {
		for (const source of ["npm:mason-slack@0.1.0", "git:github.com/DenisSud/mason-slack@v1"]) {
			// Parsed: the form is understood, which is the promise the file format makes.
			const parsed = parseSource(source);
			assert.throws(() => requireInstallable(parsed), /not available in this release.*0\.1\.1/s);
		}
		// And the two that work pass the same gate, so no caller has to special-case them.
		requireInstallable(parseSource("catalog:telegram@0.2.0"));
		requireInstallable(parseSource("url:ws://127.0.0.1:8082"));
	});
});

describe("service/connectors.json", () => {
	test("a fresh home has installed nothing", async () => {
		assert.deepEqual(await readInstalls(await temporaryHome()), { connectors: {} });
	});

	test("round trips a record to service/connectors.json", async () => {
		const paths = await temporaryHome();
		const install = record("catalog:telegram@0.2.0", {
			image: "ghcr.io/denissud/mason-telegram:0.2.0",
			version: "0.2.0",
			started: true,
		});
		await writeInstall(paths, "telegram", install);
		assert.deepEqual((await readInstalls(paths)).connectors.telegram, install);
		assert.equal(
			paths.connectors,
			join(paths.serviceDir, "connectors.json"),
			"beside the grant, in the service half",
		);
		const text = await readFile(paths.connectors, "utf8");
		assert.doesNotMatch(text, /masonc_/, "no credential is ever written here");
	});

	test("a second write for the same connector updates the record rather than adding a second one", async () => {
		const paths = await temporaryHome();
		await writeInstall(paths, "telegram", record("catalog:telegram@0.2.0", { started: false }));
		await writeInstall(paths, "telegram", record("catalog:telegram@0.2.0", { started: true }));
		const { connectors } = await readInstalls(paths);
		assert.deepEqual(Object.keys(connectors), ["telegram"]);
		assert.equal(connectors.telegram?.started, true, "the later write is the record");
	});

	test("a new connector leaves the existing one exactly as it was", async () => {
		const paths = await temporaryHome();
		const first = record("catalog:telegram@0.2.0", { image: "ghcr.io/denissud/mason-telegram:0.2.0", started: true });
		await writeInstall(paths, "telegram", first);
		await writeInstall(paths, "console", record("catalog:console@0.1.0", { project: "a1b2c3d4-console" }));
		const { connectors } = await readInstalls(paths);
		assert.deepEqual(connectors.telegram, first);
		assert.deepEqual(Object.keys(connectors), ["console", "telegram"], "sorted, so a diff is stable");
	});

	test("forgetting one connector keeps the others, and says whether there was one", async () => {
		const paths = await temporaryHome();
		await writeInstall(paths, "telegram", record("catalog:telegram@0.2.0"));
		await writeInstall(paths, "console", record("catalog:console@0.1.0"));
		assert.equal(await removeInstall(paths, "telegram"), true);
		assert.deepEqual(Object.keys((await readInstalls(paths)).connectors), ["console"]);
		assert.equal(await removeInstall(paths, "telegram"), false, "a typo must not read as a removal");
	});

	test("a record this release cannot act on is a refusal naming the file", async () => {
		const paths = await temporaryHome();
		await writeFile(
			paths.connectors,
			JSON.stringify({
				connectors: { telegram: { source: "tarball:x", project: "p", createdAt: "now", started: true } },
			}),
		);
		await assert.rejects(readInstalls(paths), /is not a source mason reads/);
	});

	test("a file that is not JSON is a refusal naming the path, not an empty set", async () => {
		const paths = await temporaryHome();
		await writeFile(paths.connectors, "{");
		await assert.rejects(readInstalls(paths), /connectors\.json is not JSON/);
	});
});
