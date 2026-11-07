/**
 * `mason doctor`: nine read-only checks over one bot's configuration, and an exit code a CI job can trust.
 *
 * The rule the checks share is the one openclaw's outro taught (`docs/research/openclaw-cli.md` §1.1): a failure is one
 * sentence naming one repair command, never a stack trace and never a fix. Doctor changes nothing — not a file, not a
 * container, not a credential — because a command that repairs is a command whose report can no longer be trusted to say
 * what was wrong. The repair it names is the command a person would have typed.
 *
 * The nine are ordered from the home outward, which is also the order a boot meets them: the two halves, the model, the
 * execution environment, the server, podman, the boot policy, each connector's container, the integration file, and the
 * exit-code shape itself. Checks 5 and 6 only run when a connector actually runs in a container: a bot whose only
 * connector is the console needs no podman, and failing it for a dependency it does not have is the kind of noise that
 * teaches people to ignore a doctor.
 *
 * Check 4 is honest about a stopped server. A fleet that is not running is a fleet somebody has not started, not a
 * misconfiguration — `mason up` is the next step, not a repair — so "nothing is listening" passes and says so, while a
 * server that is listening and does not answer `/api/health` fails. That is what lets `mason onboard` end in a green
 * doctor on a machine where nothing is up yet.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { localDaemon } from "@earendil-works/pi-env";
import {
	type CommonRuntime,
	commonPaths,
	hashFile,
	type ModelChoice,
	readCommonRuntime,
	readPiSettingsModel,
	resolveModelChoice,
} from "./common.ts";
import { composePath, readComposeCredential } from "./connector-compose.ts";
import { listConnectorCredentials } from "./connectors.ts";
import { HOUSE_ENTRIES, type HousePaths } from "./house.ts";
import { type ConnectorInstalls, readInstalls } from "./install-state.ts";
import { readIntegrationBoot, readIntegrations } from "./integrations.ts";
import { bootPolicyFix, checkPodman, containerStates, listening, type PodmanOptions } from "./podman.ts";
import { FAUX_MODEL } from "./runtime.ts";

/** One line of the report: what was checked, what was found, and the one command that repairs a failure. */
export interface DoctorCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
	readonly repair?: string;
}

/** What a health probe answered: the body of a 200, or the reason it did not answer. */
export interface HealthAnswer {
	readonly ok: boolean;
	readonly detail: string;
	/** The home the answering server says it serves, when it says: what makes "is this bot's server up" a question. */
	readonly home?: string;
}

export interface DoctorOptions {
	readonly house: HousePaths;
	readonly env?: NodeJS.ProcessEnv;
	/** Injected for tests; the real driver shells out to `podman` and `systemctl`. */
	readonly runner?: PodmanOptions["runner"];
	readonly probe?: PodmanOptions["probe"];
	/** Injected for tests; the real probe is one `fetch` with a short timeout. */
	readonly health?: (url: string) => Promise<HealthAnswer>;
}

/** `fetch` with a timeout short enough that a hung server is a failed check and not a hung doctor. */
async function fetchHealth(url: string): Promise<HealthAnswer> {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
		const body = (await response.text()).trim();
		const parsed = ((): { status?: unknown; home?: unknown } => {
			try {
				return JSON.parse(body) as { status?: unknown; home?: unknown };
			} catch {
				return {};
			}
		})();
		return {
			ok: response.status === 200 && parsed.status === "ok",
			detail: `${response.status} ${body.slice(0, 80)}`,
			...(typeof parsed.home === "string" ? { home: parsed.home } : {}),
		};
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The nine checks, in the order a boot meets them. */
export async function runDoctor(options: DoctorOptions): Promise<readonly DoctorCheck[]> {
	const house = options.house;
	const env = options.env ?? process.env;
	const podman: PodmanOptions = {
		...(options.runner === undefined ? {} : { runner: options.runner }),
		...(options.probe === undefined ? {} : { probe: options.probe }),
	};
	const checks: DoctorCheck[] = [];
	checks.push(checkHome(house));
	checks.push(await checkModel(house, env));
	checks.push(await checkRuntime(house));
	checks.push(await checkServer(house, env, options.health ?? fetchHealth));
	let installs: ConnectorInstalls | undefined;
	let installsError: string | undefined;
	try {
		installs = await readInstalls(house);
	} catch (error) {
		// A record mason cannot read is a configuration fault, not "no containers": check 7 has to say so.
		installsError = error instanceof Error ? error.message : String(error);
	}
	const containers = Object.entries(installs?.connectors ?? {}).filter(([, record]) => record.project !== undefined);
	checks.push(await checkPodmanTool(containers.length > 0, podman));
	checks.push(await checkBootPolicy(containers.length > 0, podman));
	checks.push(await checkConnectors(house, containers, podman, installsError));
	checks.push(await checkIntegrations(house));
	checks.push(checkExitShape(checks));
	return checks;
}

/** One line of the report, in the shape every caller prints: `[ok] name: detail (repair: …)`. */
export function formatCheck(check: DoctorCheck): string {
	const repair = check.repair === undefined ? "" : ` (repair: ${check.repair})`;
	return `[${check.ok ? "ok" : "fail"}] ${check.name}: ${check.detail}${repair}`;
}

/** Every check passed: the one number a script reads. */
export function doctorExitCode(checks: readonly DoctorCheck[]): 0 | 1 {
	return checks.every((check) => check.ok) ? 0 : 1;
}

/** The two halves, and no bare home addressed as a fleet. */
function checkHome(house: HousePaths): DoctorCheck {
	const legacy = HOUSE_ENTRIES.map((entry) => entry.name).filter((name) => existsSync(join(house.home, name)));
	if (legacy.length > 0)
		return {
			name: "home",
			ok: false,
			detail: `${house.home} holds ${legacy.join(", ")} at its root`,
			repair: "move them into agent/ or service/ by hand, then run `mason doctor` again",
		};
	if (!existsSync(house.agentDir) || !existsSync(house.serviceDir))
		return {
			name: "home",
			ok: false,
			detail: `${house.home} is missing agent/ or service/`,
			repair:
				house.fleet === undefined
					? "run `mason onboard` to create the home"
					: `run \`mason onboard -b ${house.fleet.bot}\` to finish this bot's home`,
		};
	return { name: "home", ok: true, detail: `${house.home} (agent/, service/)` };
}

/** Provider, model and key resolve, and the key is never printed. */
async function checkModel(house: HousePaths, env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
	let choice: ModelChoice | undefined;
	try {
		choice = await resolveModelChoice(house, env);
	} catch (error) {
		return {
			name: "model",
			ok: false,
			detail: error instanceof Error ? error.message : String(error),
			repair: "fix the file it names, or run `mason init`",
		};
	}
	if (choice === undefined) {
		const fallback = house.fleet === undefined ? readPiSettingsModel() : undefined;
		if (fallback !== undefined)
			return {
				name: "model",
				ok: true,
				detail: `${fallback.provider}/${fallback.modelId} from pi's settings.json (a MASON_HOME home)`,
			};
		return {
			name: "model",
			ok: false,
			detail: `no provider and model resolve for ${house.home}`,
			repair: house.fleet === undefined ? "run `mason init`" : `run \`mason init\` for the root ${house.fleet.root}`,
		};
	}
	const ref = `${choice.provider}/${choice.modelId}`;
	const from = choice.source === "bot" ? " from the bot's settings.json" : "";
	// The switch is not the store: `PI_FAUX_MODEL=1` makes the turn run the offline provider whatever the file names, so it
	// can neither satisfy "this provider has a key" nor let the check report a model the boot will not use.
	const offline = env.PI_FAUX_MODEL === "1";
	const runs = offline ? `PI_FAUX_MODEL=1: the turn runs ${FAUX_MODEL.provider}/${FAUX_MODEL.modelId}; ` : "";
	if (choice.source === "env") return { name: "model", ok: true, detail: `${runs}${ref} from PI_PROVIDER/PI_MODEL` };
	if (choice.provider === "faux")
		return { name: "model", ok: true, detail: `${ref}${from}, the offline provider needs no key` };
	if (choice.key !== undefined) return { name: "model", ok: true, detail: `${runs}${ref}${from}, key stored` };
	// A home addressed directly has no common store to check: its key is the one pi's own store or the provider's
	// environment answers with, and this build reads neither.
	if (choice.source === "bot" && house.fleet === undefined)
		return { name: "model", ok: true, detail: `${ref} from the bot's settings.json (a MASON_HOME home)` };
	const where = house.fleet === undefined ? "common/auth.json" : commonPaths(house.fleet.root).auth;
	return {
		name: "model",
		ok: false,
		detail: `${runs}${ref}${from} has no key in ${where}`,
		repair: "run `mason init` to verify and store one",
	};
}

/** The execution environment: the local daemon this build ships, or the ssh target a runtime.json names. */
async function checkRuntime(house: HousePaths): Promise<DoctorCheck> {
	let runtime: Pick<CommonRuntime, "kind" | "host"> = { kind: "local", host: undefined };
	if (house.fleet !== undefined) {
		try {
			const read = await readCommonRuntime(house.fleet.root);
			runtime = { kind: read.kind, host: read.host };
		} catch (error) {
			return {
				name: "runtime",
				ok: false,
				detail: error instanceof Error ? error.message : String(error),
				// `mason init` refuses to overwrite a file it cannot read, so naming it was a repair that could not repair.
				repair: "fix or delete common/runtime.json, then run `mason doctor` again",
			};
		}
	}
	if (runtime.kind === "ssh")
		return runtime.host === undefined
			? {
					name: "runtime",
					ok: false,
					detail: "the ssh runtime names no host",
					repair: "add a host to common/runtime.json, or delete it to run locally",
				}
			: {
					name: "runtime",
					ok: true,
					// Named, not dialled: a check that opens an ssh session hangs on a slow host, and the question here is
					// whether the configuration names a machine the boot will use.
					detail: `ssh ${runtime.host}, configured (doctor does not open a session)`,
				};
	const daemon = localDaemon();
	return existsSync(daemon)
		? { name: "runtime", ok: true, detail: "local (the pi-env daemon is where this build says it is)" }
		: {
				name: "runtime",
				ok: false,
				detail: `the pi-env daemon is missing at ${daemon}`,
				repair: "reinstall mason-agent: the daemon ships in @earendil-works/pi-env",
			};
}

/** The server: nothing listening is "not started", and a listening server has to answer. */
async function checkServer(
	house: HousePaths,
	env: NodeJS.ProcessEnv,
	health: (url: string) => Promise<HealthAnswer>,
): Promise<DoctorCheck> {
	const port = Number(env.PORT ?? 8787);
	const host = env.HOST ?? "127.0.0.1";
	// A wildcard bind answers loopback; any other address is the one to dial. Probing 127.0.0.1 whatever `HOST` said made a
	// server bound to a concrete LAN address read as "not started" — and check 4 unable to fail for it.
	const dial = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
	if (!(await listening(dial, port)))
		return { name: "server", ok: true, detail: `nothing is listening on ${dial}:${port} yet (mason up starts it)` };
	const answer = await health(`http://${dial}:${port}/api/health`);
	if (!answer.ok)
		return {
			name: "server",
			ok: false,
			detail: `/api/health did not answer: ${answer.detail}`,
			repair: `check what is bound to ${port}, then run \`mason up\``,
		};
	// A port is not an identity: a scratch bot's doctor used to report the live bot on 8787 as its own server.
	if (answer.home !== undefined && resolve(answer.home) !== resolve(house.home))
		return {
			name: "server",
			ok: false,
			detail: `${dial}:${port} answers, but it serves ${answer.home}, not ${house.home}`,
			repair: "run `mason up` for this home on its own PORT, or stop the server that owns the port",
		};
	return { name: "server", ok: true, detail: `listening on ${dial}:${port}, /api/health answers for this home` };
}

/** podman and a compose provider, only for a bot that runs one. */
async function checkPodmanTool(needed: boolean, options: PodmanOptions): Promise<DoctorCheck> {
	if (!needed) return { name: "podman", ok: true, detail: "no connector runs in a container" };
	const result = await checkPodman(options);
	return result.ok
		? { name: "podman", ok: true, detail: "podman and a compose provider" }
		: {
				name: "podman",
				ok: false,
				detail: result.fix,
				repair: "install what the line names, then run `mason doctor` again",
			};
}

/** `podman-restart.service` and linger, the half of `restart: always` a file cannot carry. */
async function checkBootPolicy(needed: boolean, options: PodmanOptions): Promise<DoctorCheck> {
	if (!needed) return { name: "boot", ok: true, detail: "no connector runs in a container" };
	const fix = await bootPolicyFix(options);
	return fix === undefined
		? { name: "boot", ok: true, detail: "podman-restart.service is enabled and this user lingers" }
		: { name: "boot", ok: false, detail: fix, repair: "run the commands the line names" };
}

/** Every container connector: the project rendered, the container up, the credential it was handed still live. */
async function checkConnectors(
	house: HousePaths,
	containers: readonly (readonly [string, { readonly project?: string }])[],
	options: PodmanOptions,
	broken: string | undefined,
): Promise<DoctorCheck> {
	if (broken !== undefined)
		return {
			name: "connectors",
			ok: false,
			detail: broken,
			repair: `fix ${house.connectors} by hand, or delete it and run \`mason setup\` for each connector`,
		};
	if (containers.length === 0) return { name: "connectors", ok: true, detail: "no connector runs in a container" };
	const live = await listConnectorCredentials(house.home).catch(() => []);
	const lines: string[] = [];
	let repair: string | undefined;
	for (const [name, record] of containers) {
		const project = record.project as string;
		const path = composePath(house, name);
		const setup = `mason setup --connector ${name}`;
		if (!existsSync(path)) {
			lines.push(`${name}: no compose file`);
			repair ??= setup;
			continue;
		}
		const states = await containerStates(project, options).catch(() => []);
		const running = states.filter((state) => state.state === "running");
		if (running.length === 0) {
			lines.push(`${name}: ${states.length === 0 ? "no container" : states.map((state) => state.state).join(", ")}`);
			repair ??= `podman compose -f ${path} -p ${project} up -d`;
			continue;
		}
		const held = await readComposeCredential(path);
		const matches =
			held !== undefined && live.some((entry) => entry.connector === name && entry.sha256 === sha256(held));
		if (!matches) {
			lines.push(`${name}: up, but its credential is not one this home holds`);
			repair ??= setup;
			continue;
		}
		lines.push(`${name}: up`);
	}
	return repair === undefined
		? { name: "connectors", ok: true, detail: lines.join("; ") }
		: { name: "connectors", ok: false, detail: lines.join("; "), repair };
}

/** The integration file parses, and it is the file the last boot read. */
async function checkIntegrations(house: HousePaths): Promise<DoctorCheck> {
	try {
		await readIntegrations(house);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			name: "integrations",
			ok: false,
			detail: message,
			repair: `fix ${house.integrations} by hand, then run \`mason doctor\` again`,
		};
	}
	if (!existsSync(house.integrations))
		return {
			name: "integrations",
			ok: true,
			detail: `${house.integrations} is absent: no integration is configured`,
		};
	const boot = await readIntegrationBoot(house);
	if (boot === undefined)
		return { name: "integrations", ok: true, detail: `${house.integrations} parses (not booted yet)` };
	const current = (await hashFile(house.integrations)) ?? null;
	if (current !== boot.integrations)
		return {
			name: "integrations",
			ok: false,
			detail: `${house.integrations} changed since the boot at ${boot.bootedAt}`,
			repair: "restart to apply: `mason up`",
		};
	return { name: "integrations", ok: true, detail: `${house.integrations} parses, unchanged since the last boot` };
}

/** The ninth check is the contract the other eight are read through: this report exits 0 or 1, and the line says which. */
function checkExitShape(checks: readonly DoctorCheck[]): DoctorCheck {
	const code = doctorExitCode(checks);
	return {
		name: "exit",
		ok: code === 0 || code === 1,
		detail: `this report exits ${code} (0 when every check passes, 1 when one fails)`,
	};
}
