/**
 * `scripts/init.ts` — the common store, and the one completion that comes before it.
 *
 * The flow is run in-process, the way `test/setup.test.ts` runs setup: `runInit` takes a prompter and an optional
 * provider access, so the wizard's answers and the provider's answer are scripted without a terminal or a network. What
 * is pinned is the promise the command makes: a provider and model are stored only after one real completion, the write
 * is one staged commit with the previous file beside it, and a second run asks nothing and writes nothing.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { runInit } from "../scripts/init.ts";
import { MODEL_QUESTION, PROVIDER_QUESTION, scriptedPrompter } from "../scripts/wizard.ts";
import {
	COMMON_VERSION,
	commonPaths,
	readCommonAuth,
	readCommonRuntime,
	readCommonSettings,
} from "../src/server/common.ts";
import type { ProviderAccess } from "../src/server/provider.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-init-"));
	directories.add(directory);
	return directory;
}

/** The offline provider, with one scripted answer and a counter the test can read. */
function offline(): { access: ProviderAccess; answers: () => number } {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);
	const access: ProviderAccess = { models, faux: true };
	return { access, answers: () => faux.state.callCount };
}

/** The prompter a `--yes` run gets, with the two questions answered as flags would answer them. */
function prompter(): ReturnType<typeof scriptedPrompter> {
	return scriptedPrompter({
		picks: new Map([[PROVIDER_QUESTION, "faux"]]),
		texts: new Map([[MODEL_QUESTION, "faux-1"]]),
	});
}

describe("a first init", () => {
	test("verifies once, then writes the three files", async () => {
		const root = await tempRoot();
		const offlineAccess = offline();
		const code = await runInit(["--yes"], { root, prompter: prompter(), access: offlineAccess.access });
		assert.equal(code, 0);
		assert.equal(offlineAccess.answers(), 1, "one completion, before anything was written");

		const paths = commonPaths(root);
		const settings = await readCommonSettings(root);
		assert.equal(settings.value.defaultProvider, "faux");
		assert.equal(settings.value.defaultModel, "faux-1");
		assert.equal(settings.value.version, COMMON_VERSION);
		assert.deepEqual(await readCommonAuth(root), { version: COMMON_VERSION, providers: {} });
		assert.deepEqual(await readCommonRuntime(root), { version: COMMON_VERSION, kind: "local" });
		assert.equal(existsSync(paths.settings), true);
	});

	test("a second run asks nothing and rewrites nothing", async () => {
		const root = await tempRoot();
		assert.equal(await runInit(["--yes"], { root, prompter: prompter(), access: offline().access }), 0);
		const path = commonPaths(root).settings;
		const before = await readFile(path, "utf8");
		// A prompter that would throw on any question: the run must not ask one.
		const refusing = scriptedPrompter({});
		assert.equal(await runInit(["--yes"], { root, prompter: refusing, access: offline().access }), 0);
		assert.equal(await readFile(path, "utf8"), before);
	});

	test("keeps the file it replaces, beside it, with the keys mason does not know", async () => {
		const root = await tempRoot();
		const path = commonPaths(root).settings;
		await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
		await writeFile(path, JSON.stringify({ version: COMMON_VERSION, future: "kept" }), "utf8");
		assert.equal(await runInit(["--yes"], { root, prompter: prompter(), access: offline().access }), 0);
		const settings = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		assert.equal(settings.future, "kept");
		const backups = (await readdir(join(path, ".."))).filter(
			(name) => name.startsWith("settings.json.") && name.endsWith(".bak"),
		);
		assert.equal(backups.length, 1, "the file it replaced is one .bak beside it");
	});

	test("a provider that does not answer writes nothing", async () => {
		const root = await tempRoot();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		// No scripted responses: the completion fails before the first file is built.
		faux.setResponses([]);
		const code = await runInit(["--yes"], { root, prompter: prompter(), access: { models, faux: true } });
		assert.equal(code, 1);
		assert.equal(existsSync(commonPaths(root).dir), false, "nothing was written");
	});

	test("a headless run with no provider names the flag that answers it, not the connector's", async () => {
		const root = await tempRoot();
		// Two providers, so the list cannot be answered by being the only choice: the refusal has to name the flag.
		const first = fauxProvider();
		const second = fauxProvider({ provider: "second" });
		const models = createModels();
		models.setProvider(first.provider);
		models.setProvider(second.provider);
		const code = await runInit(["--yes"], {
			root,
			prompter: scriptedPrompter({}),
			access: { models, faux: true },
		});
		assert.equal(code, 2, "a missing answer is not a failed store");
		assert.equal(existsSync(commonPaths(root).dir), false);
	});

	test("the offline provider asks for no key, and a --key beside it stores none", async () => {
		const root = await tempRoot();
		// The prompter would throw if it were asked anything: `--provider` and `--model` answer both questions, and the
		// offline provider needs no key.
		const code = await runInit(["--yes", "--provider", "faux", "--model", "faux-1", "--key", "sk-test"], {
			root,
			prompter: scriptedPrompter({}),
			access: offline().access,
		});
		assert.equal(code, 0);
		assert.deepEqual((await readCommonAuth(root)).providers, {});
	});
});
