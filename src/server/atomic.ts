/**
 * The one way a service-half file is written: privately, whole, and through a rename.
 *
 * `config.json` (the hashes of the tokens that may talk to the server and of the connector credentials) and
 * `integrations.json` (a connector's grant) are small files the server reads while running and a person reads in a
 * diff. Two things follow, and they are the same for both: a reader must never see half a file, so the write goes
 * to a temporary in the same directory and is renamed over the target once it is whole — a crash leaves the previous
 * file, not a truncated one; and nothing outside the owner may read it, so the file is `0600` and its directory `0700`.
 *
 * The modes are set after the rename rather than trusted from it: `writeFile`'s `mode` applies only when it creates the
 * file, and the directory keeps whatever modes it already had, so both are re-applied on every write. The `catch` is
 * for filesystems without modes: there is nothing to set there, and a failure to set one is not a failed write.
 */
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Write `value` to `path` as JSON, two-space indented, in one atomic step. Returns nothing: the caller's next read is
 * the proof, and a caller that reported success from here would be reporting the rename, not the file.
 */
export async function writeFileAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
	await chmod(dirname(path), 0o700).catch(() => {});
	await chmod(path, 0o600).catch(() => {});
}
