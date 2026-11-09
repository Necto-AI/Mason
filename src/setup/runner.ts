/**
 * The one process effect an install has: starting a compose project.
 *
 * `applyPlan` writes files and then, when the plan has a project and the person did not pass `--no-start`, asks for the
 * container to come up. That is the only thing setup runs, and it is a seam for one reason: a test of the install path
 * should not need podman, and `mason setup` on a machine without it should fail at the start rather than at the write.
 * One method, because one is what setup needs — a `status` or a `down` nobody calls is a guess about the next caller
 * (`src/server/podman.ts` already takes the same shape for its commands).
 *
 * `noopRunner` is not a placeholder. `--no-start` renders the project and starts nothing, which is a state setup already
 * offers, and a caller that only wants the files passes it instead of a podman that is not there.
 */
import { up } from "../server/podman.ts";

export interface Runner {
	/** Starts one compose project and resolves with what it printed. Rejects when it could not start it. */
	up(composeFile: string, project: string): Promise<string>;
}

/** The real one: `podman compose up -d`, and podman's own output in return. */
export const podmanRunner: Runner = {
	up: (composeFile, project) => up(composeFile, project),
};

/** Starts nothing and prints nothing: what `--no-start` and a test both need. */
export const noopRunner: Runner = {
	up: async () => "",
};
