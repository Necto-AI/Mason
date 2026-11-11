/**
 * The Node floor, and the sentence a run under it is refused with.
 *
 * `@opentui/core` loads its native half through `node:ffi`, which does not exist below Node 26.4, and the onboarding
 * wizard imports it on its first screen. A run below the floor therefore fails inside a dependency, with a stack trace
 * naming neither mason nor the version, at the one moment a person has no other evidence that mason works. So the floor
 * is checked in the entry point before anything else is loaded, and the refusal says what to install.
 *
 * This module is deliberately alone: no imports, no `node:` builtins, nothing to evaluate. `bin/mason.ts` imports it
 * before it imports the command it dispatches, and the test beside it fails if anything but this file is added to that
 * import list. The floor can only be enforced by code that runs on the version being refused.
 */

/** The oldest Node mason runs on, one floor for the runtime, the CLI, the wizard and the TUI. */
export const NODE_FLOOR = "26.4.0";

/** A version string as three numbers, or `undefined` when it is not one this check can compare. */
function parse(version: string): readonly [number, number, number] | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	if (match === null) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `a` is older than `b`, zero when they are the same release. */
function compare(a: readonly [number, number, number], b: readonly [number, number, number]): number {
	for (let i = 0; i < 3; i += 1) {
		const difference = (a[i] as number) - (b[i] as number);
		if (difference !== 0) return difference;
	}
	return 0;
}

/**
 * Why `current` cannot run mason, or `null` when it can.
 *
 * A version this check cannot read is refused rather than allowed: the floor exists because a version below it fails
 * somewhere unhelpful, and a string nobody can parse is not a promise that the version is recent.
 */
export function tooOld(current: string): string | null {
	const running = parse(current);
	if (running === undefined) {
		return `mason cannot read this Node's version ("${current}") and needs Node.js ${NODE_FLOOR} or newer.\nRun \`node --version\` and reinstall Node from https://nodejs.org if it does not print a version.`;
	}
	if (compare(running, parse(NODE_FLOOR) as readonly [number, number, number]) >= 0) return null;
	return `mason needs Node.js ${NODE_FLOOR} or newer; this is ${current.trim()}.\nThe onboarding wizard loads its native renderer through node:ffi, which does not exist below ${NODE_FLOOR}.\nInstall a newer Node (\`nvm install 26\`, \`fnm use 26\`, or your system's package) and run this again.`;
}

/**
 * The flags a child process needs for the renderer to load, on the versions where `node:ffi` is still opt-in.
 *
 * `node:ffi` arrived in Node 26.1 behind `--experimental-ffi` and became available by default in 26.9. The floor this
 * file enforces is 26.4, which is below that line, so on the versions mason claims to support but does not default the
 * module, every process that might load the wizard has to be handed the flag. Without it the first screen a person
 * sees fails with OpenTUI's "native FFI is not available for this runtime yet" — which names neither mason nor the
 * version, and is exactly the failure the floor check above exists to stop happening.
 *
 * It returns nothing at 26.9 and above: the flag is still accepted there, but passing an experimental flag to a
 * process that no longer needs it is a thing to explain to the next reader for no reason.
 */
export function ffiFlags(current: string): readonly string[] {
	const match = /^v?(\d+)\.(\d+)/.exec(current.trim());
	if (match === null) return [];
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major === 26 && minor < 9 ? ["--experimental-ffi"] : [];
}
