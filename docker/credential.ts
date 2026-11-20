/**
 * The one question the server cannot answer before it starts: does the model it resolved have a credential?
 *
 * A server with a model and no key boots, listens, and fails every turn — the failure is a provider error in a
 * transcript rather than a refusal an operator reads at start. This asks the same two questions the boot asks:
 * `resolveModelChoice` (`common.ts`) for the model this home runs, and `ModelRuntime.getProviderAuthStatus` for whether
 * anything answers for that provider. It prints one `[boot]` sentence and exits 1 when nothing does.
 *
 * `PI_FAUX_MODEL=1` is the first answer: the offline provider is one this build plays itself and has no credential to
 * resolve. A key in the root's `common/auth.json` is the second: `resolveModelChoice` already carries it, and the boot
 * sets it as a runtime key. Everything else — pi's own store, a provider's environment variable, an `apiKey` in
 * `models.json` — is `ModelRuntime`'s to answer, which is why no second store is read by hand here.
 *
 * Called by `entrypoint.sh` with the root and the home, from `/app` (the image's WORKDIR).
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	type ModelChoice,
	readCommonSettings,
	readRoleMap,
	resolveModelChoice,
} from "../packages/mason-agent/src/server/common.ts";
import { housePaths } from "../packages/mason-agent/src/server/house.ts";

const [root, home] = process.argv.slice(2);
if (root === undefined || root === "") fail("the entrypoint passed no root");

/** One `[boot]` line and exit 1: the entrypoint runs under `set -e`, so this is the boot's refusal. */
function fail(message: string): never {
	console.error(`[boot] ${message}`);
	process.exit(1);
}

// The offline provider has no credential to resolve, and `resolveModelAccess` short-circuits to it before any store is
// read (`runtime.ts`). A check that refused it would refuse every test and demo boot this repository documents.
if (process.env.PI_FAUX_MODEL === "1") process.exit(0);

try {
	// A home is the bot's directory under the root; without one, the root's own `common/` still names the model, and
	// the server's refusal is the missing bot rather than a missing key.
	const house = home === undefined || home === "" ? undefined : housePaths(home);
	const choice: ModelChoice | undefined = house === undefined ? undefined : await resolveModelChoice(house);
	const roles = house === undefined ? await readRoleMap(root) : undefined;
	const settings = house === undefined ? await readCommonSettings(root) : undefined;
	// `resolveModelChoice` takes the environment only when both halves are there, and the fallback below does the same:
	// `PI_PROVIDER` without `PI_MODEL` is not a model the server would run.
	const envModel = process.env.PI_PROVIDER !== undefined && process.env.PI_MODEL !== undefined;
	const configuredInCommon = roles !== undefined || settings?.value.defaultProvider !== undefined;
	const provider =
		choice?.provider ??
		roles?.main.provider ??
		settings?.value.defaultProvider ??
		(envModel ? process.env.PI_PROVIDER : undefined);
	const source =
		choice?.source === "bot"
			? `${home}/service/settings.json`
			: configuredInCommon || choice?.source === "roles" || choice?.source === "common"
				? `${root}/common/settings.json`
				: envModel
					? "PI_PROVIDER/PI_MODEL"
					: `${root}/common/settings.json`;

	if (provider === undefined) {
		fail(
			`no provider credential and no model: ${root}/common/settings.json names no defaultProvider and ` +
				"PI_PROVIDER/PI_MODEL are unset. Run `mason init` for this root.",
		);
	}
	if (choice?.key !== undefined) process.exit(0);

	// The store's key is the first answer. Everything else is the same catalog the server builds: pi's own credential
	// store, the provider's environment variables, and an `apiKey` in `models.json`. Whether the provider itself is a
	// physical or a virtual one is not this check's question — only whether something answers for it.
	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	const status = runtime.getProviderAuthStatus(provider);
	if (status.configured) process.exit(0);
	fail(
		`no provider credential: ${provider} (from ${source}) has no key in ${root}/common/auth.json, in pi's ` +
			`credential store, or in the environment, so every turn would fail. Run \`mason init\` for this root, or set ` +
			"PI_FAUX_MODEL=1 to run the offline provider.",
	);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
