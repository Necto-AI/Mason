/**
 * What a boot refuses before anything can run.
 *
 * Two enabled connectors that each carry a person's words are two surfaces claiming to be where the answer arrives.
 * That claim is where #199's and #200's lost answers lived: a grant's words came back addressed to the other's, and
 * nothing in the file said which one was the person's chat. One bot works for one person, so the boot refuses the home
 * rather than discovering it from a message that went somewhere nobody read.
 *
 * The refusal is the boot's and not the reader's: `mason setup` still writes what the operator asked for, and `status`
 * and `doctor` still report the file as it is — which is what lets an operator fix the home the refusal names.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { housePaths } from "../src/server/house.ts";
import { type AgentRuntime, openAgentRuntime, type ResolvedModel } from "../src/server/runtime.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

/** A provider with nothing scripted: no turn is started here, so no generation is asked for. */
function fauxAccess(): ResolvedModel {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true };
}

/** A home whose `service/integrations.json` holds `declared`, laid out the way a boot expects to find it. */
async function homeWith(declared: unknown): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-runtime-boot-"));
	directories.add(directory);
	const paths = housePaths(join(directory, "house"));
	await mkdir(dirname(paths.integrations), { recursive: true, mode: 0o700 });
	await writeFile(paths.integrations, JSON.stringify({ integrations: declared }), { encoding: "utf8", mode: 0o600 });
	return paths.home;
}

/** One entry's grant: a person's words (the default), or only the kinds it may raise. */
function grant(options: { readonly user?: boolean } = {}): Record<string, unknown> {
	return options.user === false
		? { events: { hooks: { "alarm.ringing": "workspace-check" } } }
		: { user: { owner: "8811" } };
}

/** Open a home's runtime, answering with the failure instead of throwing: a boot that did not refuse must be closed. */
async function boot(home: string): Promise<AgentRuntime | Error> {
	return openAgentRuntime(BACKGROUND_CONTEXT, {
		dataDir: join(dirname(home), "data"),
		workspaceDir: join(dirname(home), "workspace"),
		houseHome: home,
		storage: "memory",
		modelAccess: fauxAccess(),
		onReport: () => {},
	}).then(
		async (runtime) => {
			await runtime.close();
			return runtime;
		},
		(error: unknown) => (error instanceof Error ? error : new Error(String(error))),
	);
}

test("two enabled connectors that carry a person's words refuse the boot, and the sentence names the rule", async () => {
	const home = await homeWith({
		telegram: { enabled: true, connector: grant() },
		slack: { enabled: true, connector: grant() },
	});
	const refused = await boot(home);
	assert.ok(refused instanceof Error, "the boot refused the home");
	assert.match(refused.message, /"telegram" and "slack" are enabled and each holds a "connector\.user" grant/);
	assert.match(refused.message, /at most one enabled connector may carry a person's words/);
	assert.match(refused.message, /switch one of them off, by hand/, "the refusal says what to do about it");
});

test("disabling one of them is the whole fix, and the same home boots", async () => {
	const home = await homeWith({
		telegram: { enabled: true, connector: grant() },
		slack: { enabled: false, connector: grant() },
	});
	const runtime = await boot(home);
	assert.ok(!(runtime instanceof Error), runtime instanceof Error ? runtime.message : undefined);
});

test("a connector that only raises events is not a second surface, and boots beside the one that speaks", async () => {
	const home = await homeWith({
		telegram: { enabled: true, connector: grant() },
		alarm: { enabled: true, connector: grant({ user: false }) },
	});
	const runtime = await boot(home);
	assert.ok(!(runtime instanceof Error), runtime instanceof Error ? runtime.message : undefined);
});
