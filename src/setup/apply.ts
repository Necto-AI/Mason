/**
 * `applyPlan` — one call makes the writes a plan implies, and starts what it asks for.
 *
 * The plan decided everything that could be decided by reading (`plan.ts`); this makes it true on disk and asks the runner
 * for the container. It never prints: it returns the notes the command prints, in the order it would print them, so the
 * same apply can be a command's output, a test's assertion, or a program that wanted the files and not the prose.
 *
 * Two promises from the code it replaces are kept here, both about order. Every store write goes through the writer that
 * owns it — so `integrations.json` is still validated, merged and staged, and `config.json` still holds only the hash —
 * and the install record is written even when the start failed, with the failure going back to the caller afterwards. A
 * start that fails therefore costs a bad `podman` line and not a home that forgets what it installed. The one exception
 * is the image pull: a pull that never landed is not an install, so no record is written and `mason doctor` has nothing
 * to claim. The files and the grant stay, because the next attempt should not mint a second credential.
 */
import { readFile } from "node:fs/promises";
import { writeTextAtomic } from "../server/atomic.ts";
import { updateConfig } from "../server/auth.ts";
import { writeInstall } from "../server/install-state.ts";
import { writeIntegration } from "../server/integrations.ts";
import { bootPolicyFix, checkPodman, listening, loopbackRefusal, PullFailure, pullFailure } from "../server/podman.ts";
import { masonPort, type Plan, type PlannedCredential } from "./plan.ts";
import type { Runner } from "./runner.ts";

/**
 * One line of the report.
 *
 * `advice` is the command's own words, and the command prefixes those with its own name. `value` is printed as it stands
 * because it is something a person keeps — the credential, which is copied out of a terminal — or something another
 * program said, like podman's own output.
 */
export interface PlanNote {
	readonly text: string;
	readonly kind: "advice" | "value";
}

/** What applying a plan did. */
export interface AppliedPlan {
	/** The lines the command prints, in the order it prints them. */
	readonly notes: readonly PlanNote[];
	/**
	 * The plan's writes that landed: the ones this run created or rewrote. The files written through their own writers —
	 * `integrations.json`, `config.json` and the install record — are not listed here.
	 */
	readonly written: readonly string[];
	/** Whether a credential left this run: `minted` for the connector's first, `rotated` for one the project had lost. */
	readonly credential?: "minted" | "rotated";
	/** Whether the runner started the project. */
	readonly started: boolean;
	/**
	 * The start that failed. The record is written either way, unless the failure was the image pull: a failed pull is
	 * not an install, and the caller raises this after it prints the notes.
	 */
	readonly failure?: unknown;
}

export interface ApplyOptions {
	/** The process effect: `podmanRunner` for the command, `noopRunner` for a test or a home that starts nothing. */
	readonly runner: Runner;
	/** `--no-start`: write everything and leave the container down. */
	readonly start: boolean;
}

/**
 * Store what the plan minted: the label and the hash, never the value.
 *
 * The write is `config.json`'s own (`auth.ts`): whole, staged with a timestamped copy beside it, under the store's lock,
 * so two setups and a `mason connector add` cannot each merge into the file they saw before the other wrote. `replace`
 * drops every record for this connector on the way — retiring one is what a rotation is — and keeps every other entry as
 * it is, including one this release does not recognise.
 */
async function issue(home: string, credential: PlannedCredential): Promise<void> {
	await updateConfig(home, (config) => {
		const existing = Array.isArray(config.connectors) ? config.connectors : [];
		const speaksFor = (entry: unknown): boolean =>
			typeof entry === "object" &&
			entry !== null &&
			(entry as { connector?: unknown }).connector === credential.record.connector;
		return {
			...config,
			connectors: [...(credential.replace ? existing.filter((e) => !speaksFor(e)) : existing), credential.record],
		};
	});
}

/**
 * One connector installed: the grant, the credential, the project, the container, the record — the order of the failures
 * it can hit, and the order the command's output has always had.
 */
export async function applyPlan(plan: Plan, options: ApplyOptions): Promise<AppliedPlan> {
	const { paths, name } = plan;
	const notes: PlanNote[] = [];
	const written: string[] = [];
	const advice = (text: string): void => {
		notes.push({ text, kind: "advice" });
	};
	const value = (text: string): void => {
		notes.push({ text, kind: "value" });
	};

	// The grant goes through the writer the boot itself uses: a bug here refuses here, and a connector granted by hand
	// keeps its own line, because what the model is told about an integration is not setup's to replace.
	if (plan.entry !== undefined) {
		await writeIntegration(paths, name, plan.entry);
		advice(`wrote the grant for "${name}" to ${paths.integrations}`);
	} else if (plan.previous?.source !== undefined && plan.previous.source !== plan.source) {
		// The url lives in the install record, not the grant: a second run with a different `--url` moves it, and a run
		// that did that silently was a wizard reporting success while the connector kept dialling the old address.
		advice(`"${name}" is already granted; its address moves: ${plan.previous.source} -> ${plan.source}`);
	} else {
		advice(`"${name}" is already granted in ${paths.integrations}; the grant is unchanged`);
	}

	if (plan.credential !== undefined) await issue(paths.home, plan.credential);
	if (plan.credential !== undefined && !plan.credential.replace) {
		advice(`minted connector credential ${plan.credential.record.id} (stored as a hash in ${paths.config})`);
		value(plan.credential.plaintext);
		value("this is the only time it is printed.");
	} else if (plan.held !== undefined) {
		advice(`"${name}" already has connector credential ${plan.held.id}; nothing minted`);
	}

	let started = false;
	/** Why the start did not happen. The record still goes in, unless the image is what failed. */
	let failure: unknown;
	if (plan.project !== undefined) {
		if (plan.credential?.replace === true) {
			// The project's plaintext was not the credential this home holds any more, so the plan rotated it: saying which
			// one is now live is the only way the person learns the old one stopped working.
			advice(
				`no credential this home holds was in ${plan.project.composeFile}, so one was minted: ${plan.credential.record.id}`,
			);
			value(plan.credential.plaintext);
		}
		for (const write of plan.writes) {
			const existing = await readFile(write.path, "utf8").catch(() => undefined);
			if (existing === write.text) {
				advice(`${write.path} is up to date`);
				continue;
			}
			if (existing !== undefined && write.onlyIfMissing === true) {
				advice(`${write.path} is already there and is kept`);
				continue;
			}
			await writeTextAtomic(write.path, write.text);
			written.push(write.path);
			advice(
				existing === undefined
					? `wrote ${write.path}`
					: `rewrote ${write.path}: an answer, the version, the image or the credential changed; the container is recreated below`,
			);
		}
		if (!options.start) {
			advice(
				`--no-start: nothing was started. When mason is up: podman compose -f ${plan.project.composeFile} -p ${plan.project.name} up -d`,
			);
		} else {
			try {
				const address = process.env.HOST ?? "127.0.0.1";
				const refusal = loopbackRefusal(address);
				if (refusal !== undefined) throw new Error(refusal);
				const podman = await checkPodman();
				if (!podman.ok) throw new Error(podman.fix);
				// Not a refusal: the SDK reconnects with backoff, so a container started before the server is a container
				// that connects the moment `mason up` runs. Saying so beats a crash-loop nobody was warned about.
				const port = masonPort();
				if (!(await listening("127.0.0.1", port)))
					advice(
						`mason is not listening on ${port} yet: start it with \`mason up\`, and this connector connects then`,
					);
				const output = await options.runner.up(plan.project.composeFile, plan.project.name);
				if (output !== "") value(output);
				started = true;
				advice(`started project ${plan.project.name}`);
				// `restart: always` is only half of "it comes back after a reboot", and the other half is a systemd unit no
				// compose file can enable. Said once, with the command, and never again for a machine that has it.
				const boot = await bootPolicyFix();
				if (boot !== undefined) advice(boot);
			} catch (error) {
				// A pull's own error is the report: it names the image, the registry host and the repair.
				failure = (plan.image === undefined ? undefined : pullFailure(plan.image, error)) ?? error;
			}
		}
	}

	// A failed pull is not an install: no record, so `mason doctor` has no container to claim.
	if (!(failure instanceof PullFailure))
		await writeInstall(paths, name, {
			source: plan.source,
			...(plan.image === undefined ? {} : { image: plan.image }),
			...(plan.version === undefined ? {} : { version: plan.version }),
			...(plan.project === undefined ? {} : { project: plan.project.name }),
			createdAt: plan.previous?.createdAt ?? new Date().toISOString(),
			// A `--no-start` run says nothing about a container that is already up, so it says nothing: it keeps what the last
			// run recorded rather than reporting it stopped.
			started: options.start ? started : (plan.previous?.started ?? false),
		});
	return {
		notes,
		written,
		...(plan.credential === undefined ? {} : { credential: plan.credential.replace ? "rotated" : "minted" }),
		started,
		...(failure === undefined ? {} : { failure }),
	};
}
