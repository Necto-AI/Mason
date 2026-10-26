/**
 * Code mode: one durable tool that runs model-written JavaScript whose only capability is calling other tools.
 *
 * It is the second way the model reaches a tool it was not offered. `tool_search` promotes a deferred tool into the
 * declared list, which appends to the prefix; a script calls the same tool without declaring it and can filter a large
 * answer before the model ever sees it. That is why an MCP tool is worth deferring: a 200 KB page costs one script's
 * tokens, not a turn's context.
 *
 * The tool is pi-durable's, and so is the `codemode` prompt section — `createCodemodeExtension` composes both, and its
 * section lists the tools a script can call. Installing that extension would put its section where the extension sits in
 * the selection, and the prompt is declared in `prompt.ts` (identity first, the delivery rule last, and pi-durable
 * renders sections in extension order). So this file installs the tool only, and exports the vendor's own
 * `PromptSection` object for `prompt.ts` to place. The text stays the vendor's composition; only its position is ours.
 *
 * `models: false`: a script may not spend on classifiers or image models (issue #41). No model tools are registered and
 * no `models` global exists, so a script that reaches for one fails with an ordinary `ReferenceError`.
 *
 * The sandbox is per boot, never a module singleton: `CodemodeSandboxBase.close()` is permanent — it sets `closed` and
 * rejects every later start — so a singleton closed by one runtime would refuse the next runtime's scripts in the same
 * process, which is what the test suite does constantly.
 */
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { defineExtension, type Extension, type PromptSection } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";

/** The extension's name, the tool's name, and the key of its prompt section: pi-durable spells all three this way. */
const CODEMODE = "codemode";

/** One boot's code mode: the extension to install, and the way to stop its sandbox when the runtime closes. */
export interface Codemode {
	readonly extension: Extension;
	close(): Promise<void>;
}

/** The `codemode` tool over a fresh sandbox, for one boot. */
export function createCodemode(): Codemode {
	const sandbox = new CodemodeSandbox();
	const vendor = createCodemodeExtension({ sandbox, models: false });
	return {
		extension: defineExtension({ name: CODEMODE, tools: vendor.tools ?? [] }),
		// Closing aborts a script still running and refuses later ones. The runtime closes it after the harness, so
		// nothing can start a script in a sandbox that is already closing.
		close: () => sandbox.close(),
	};
}

/**
 * The `codemode` section, as pi-durable renders it, for `prompt.ts` to declare in its own order.
 *
 * It comes from a probe extension built once here, because the vendor does not export the renderer itself (only
 * `DEFAULT_CODEMODE_INLINE_BUDGET`). The renderer reads `input.agent.callable` and constants — never the sandbox — so
 * the probe's sandbox is inert: no worker thread exists until a script runs, and this one never does.
 */
export const CODEMODE_SECTION: PromptSection = probeSection();

function probeSection(): PromptSection {
	const sections = createCodemodeExtension({ sandbox: new CodemodeSandbox(), models: false }).sections ?? [];
	const found = sections.find((candidate) => candidate.key === CODEMODE);
	if (found === undefined) {
		throw new Error(
			"pi-durable's codemode extension no longer declares a `codemode` section: the prompt would lose the list of " +
				"tools a script can call, so mason refuses to boot instead of shipping a tool nobody is told how to use",
		);
	}
	return found;
}
