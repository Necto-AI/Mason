/**
 * `mason doctor` — the nine checks, printed, with the exit code CI reads.
 *
 * The command is a shell over `runDoctor` (`src/server/doctor.ts`): it resolves which bot it is about the same way every
 * other verb does, prints one line per check, and returns 0 or 1. It writes nothing, starts nothing and fixes nothing —
 * a doctor that repairs is a doctor whose report nobody can trust to describe what was wrong.
 */
import { doctorExitCode, formatCheck, runDoctor } from "../src/server/doctor.ts";
import { housePaths } from "../src/server/house.ts";

export function usage(): string {
	return `usage: mason doctor

  Nine read-only checks over one bot's configuration: the home's halves, the provider and key, the execution environment,
  the server, podman and its compose provider, the restart policy, each connector's container and credential, the
  integration file (including whether it changed since the last boot), and the exit-code shape itself.

  -b <name>, or MASON_BOT, picks the bot when the root holds several. Exit 0 when every check passes, 1 when one fails;
  every failure names one repair command. Nothing is written, started or fixed.`;
}

export async function runDoctorCommand(argv: readonly string[]): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(usage());
		return 0;
	}
	let checks: Awaited<ReturnType<typeof runDoctor>>;
	try {
		checks = await runDoctor({ house: housePaths() });
	} catch (error) {
		console.error(`[doctor] ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	for (const check of checks) console.log(formatCheck(check));
	const failed = checks.filter((check) => !check.ok).length;
	console.log(`${checks.length} checks: ${checks.length - failed} ok, ${failed} failed`);
	return doctorExitCode(checks);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await runDoctorCommand(process.argv.slice(2)));
}
