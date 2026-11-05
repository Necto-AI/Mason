/**
 * `service/config.json`, and whether the page that opened a request is one of ours.
 *
 * There is one credential class in mason: the connector's own (`connectors.ts`). A person never presents a token here,
 * because a person never speaks to mason's HTTP surface: they speak in a chat, and the connector carries the words.
 * What survives in this file is the one config the server reads and writes, and the `Origin` check the connector
 * socket keeps — the two things that are not about who may talk.
 */
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { writeFileAtomic } from "./atomic.ts";
import { housePaths } from "./house.ts";

/** `~/.mason/service/config.json`. Unknown keys are preserved: this file grows with the agent. */
export interface MasonConfig {
	/** The credentials mason issued to connectors (`connectors.ts`): a hash, a label and a moment, never the credential. */
	readonly connectors?: readonly unknown[];
	readonly [key: string]: unknown;
}

/** `service/config.json`: the server's half of the home, which no tool ever sees. */
export function configPath(home: string): string {
	return housePaths(home).config;
}

export async function readConfig(home: string): Promise<MasonConfig> {
	try {
		const parsed: unknown = JSON.parse(await readFile(configPath(home), "utf8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as MasonConfig) : {};
	} catch {
		return {};
	}
}

/**
 * Write the config atomically and privately. A crash mid-write leaves the previous file in place, and the file and its
 * directory are `0600`/`0700` (`atomic.ts`): this is the one file whose leak is a working credential.
 */
export async function writeConfig(home: string, config: MasonConfig): Promise<void> {
	await writeFileAtomic(configPath(home), config);
}

/**
 * Whether the page that opened this request is one of ours.
 *
 * `Origin` absent means a program, not a page: curl, the native app, a test. `Origin: null` (a sandboxed frame, a
 * `file://` page) is refused: it is a page, and not one of ours.
 */
export function originAllowed(request: IncomingMessage): boolean {
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	const host = request.headers.host;
	if (host === undefined) return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}
