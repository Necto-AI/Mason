/**
 * The compose project one installed connector runs in: `service/connectors/<name>/compose.yaml`, rendered, never edited.
 *
 * The CLI starts containers (a first run that ends in "now run this" is the deficiency #145 exists to remove), so
 * something has to write the file the container is started from, and it is this. One project per connector rather than
 * one stack for the home: a stack is a deployment's unit (`deploy/`), and it carries services, networks and a build
 * context that a home has no opinion about. A connector needs an image, its environment, and the policy that brings it
 * back after a reboot.
 *
 * Three decisions are visible in the output and worth naming. `restart: always` and not `unless-stopped`, because podman
 * records a shutdown as a stop and a stopped container stays down (#86). The project name carries a hash of the home
 * path, because two homes on one host with the same connector name would otherwise fight over one project. And no port
 * is published: a connector opens an outbound socket to mason, so nothing needs to reach into it.
 */
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeTextAtomic } from "./atomic.ts";
import type { HousePaths } from "./house.ts";

/** The service name inside the project, and the file's name: one connector per project, so both are the connector's. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** An environment name a container can carry: compose writes `NAME=value` lines, so this is what it can spell. */
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * The first eight hex of a hash of the resolved home path.
 *
 * Resolved, because `~/a/../mason` and `/home/x/mason` are one home and must not be two projects; hashed, because a
 * path holds characters a compose project name cannot (a slash, a dot, a space) and the name is what `podman compose -p`
 * takes. Eight hex is a collision the operator would have to arrange on purpose, and the cost if they did is two
 * projects with one name, which podman names in its refusal.
 */
export function homeId(home: string): string {
	return createHash("sha256").update(resolve(home), "utf8").digest("hex").slice(0, 8);
}

/** `<home-id>-<connector>`: stable across restarts, distinct across homes. */
export function projectName(home: string, connector: string): string {
	return `${homeId(home)}-${connector}`;
}

/** Where one connector's project lives. A directory per connector: the compose file is the only thing in it, and a
 * second connector's file must never be one edit away from being mistaken for it. */
export function composePath(paths: HousePaths, connector: string): string {
	return join(paths.connectorsDir, connector, "compose.yaml");
}

export interface RenderComposeOptions {
	/** The integration name: the service name, the project's suffix, and the name the connector says in its hello. */
	readonly connector: string;
	/** The image with its tag, e.g. `ghcr.io/denissud/mason-telegram:0.2.0`. */
	readonly image: string;
	/** The home whose path decides the project name. */
	readonly home: string;
	/**
	 * Everything the container is handed: the two wiring variables setup computes, then the answers the person gave. The
	 * credential is one of them — a container that cannot present one never opens a socket, so it is not a secret kept
	 * outside the file the container is started from.
	 */
	readonly env: Readonly<Record<string, string>>;
}

/** A YAML double-quoted scalar. Backslash and quote are the two characters that would otherwise end the string early. */
function quoted(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The file, as text.
 *
 * The environment is written in the order it was given rather than sorted: the two wiring variables are what a person
 * reads first when a connector will not connect, and the answers below them are in the order they were asked for.
 */
export function renderCompose(options: RenderComposeOptions): string {
	if (!NAME.test(options.connector)) throw new Error(`"${options.connector}" is not a connector name`);
	if (options.image.trim() === "") throw new Error("a compose project needs an image");
	const lines = [
		"# Rendered by `mason setup`. Editing this file is fine; `mason setup` will overwrite it.",
		`name: ${projectName(options.home, options.connector)}`,
		"services:",
		`  ${options.connector}:`,
		`    image: ${quoted(options.image)}`,
		// The policy `deploy/` uses, for the reason it uses it: unless-stopped is read by podman as a stop once the
		// machine goes down, and a bot that does not come back is a bot whose owner has to be at the console (#86).
		"    restart: always",
		"    environment:",
	];
	for (const [name, value] of Object.entries(options.env)) {
		if (!ENV_NAME.test(name)) throw new Error(`"${name}" is not an environment name a container can carry`);
		lines.push(`      ${name}: ${quoted(value)}`);
	}
	// A container cannot see the host's loopback, and the socket mason serves is on the host's network: podman answers
	// `host.containers.internal` itself on a recent release, and the mapping makes it true on a build that does not.
	lines.push(
		"    extra_hosts:",
		'      - "host.containers.internal:host-gateway"',
		// Nothing published: the connector dials out, and a port on the host would be a second way in that no credential
		// of mason's covers.
		"",
	);
	return lines.join("\n");
}

/** Renders and writes the project, replacing any previous render for this connector. Returns the path and its project. */
export async function writeCompose(
	paths: HousePaths,
	options: RenderComposeOptions,
): Promise<{ readonly path: string; readonly project: string }> {
	const path = composePath(paths, options.connector);
	const text = renderCompose(options);
	const existing = await readFile(path, "utf8").catch(() => undefined);
	// Unchanged is unwritten: a re-run of setup that rewrote an identical file would make every later `podman compose`
	// start from a new mtime and re-evaluate nothing, and a test cannot tell a no-op from a write.
	if (existing !== text) await writeTextAtomic(path, text);
	return { path, project: projectName(paths.home, options.connector) };
}

/** Forgets one connector's project files. `false` when there was no directory. */
export async function removeCompose(paths: HousePaths, connector: string): Promise<boolean> {
	const directory = join(paths.connectorsDir, connector);
	const existing = await readFile(join(directory, "compose.yaml"), "utf8").catch(() => undefined);
	if (existing === undefined) return false;
	await rm(directory, { recursive: true, force: true });
	return true;
}
