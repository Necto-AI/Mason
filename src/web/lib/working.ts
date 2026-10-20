/**
 * What the agent is doing, in one line, for a reader who is not shown the machine.
 *
 * The client receives a status and a list of tool names — never arguments, never output — so this is the whole of the
 * "working" surface: a verb and the last tool the turn called. Reasoning is not a stage a person can act on, so the
 * line says that work is happening and what kind, and stops there.
 */
import type { AgentStatus } from "../../shared/contract.ts";

/**
 * How long a tool's name stays on the line after the tool is no longer running, when it has not already been there
 * that long.
 *
 * A fast tool — a `bash` that returns in 30 ms — otherwise shows its name for one or two frames, which reads as a
 * flicker instead of as work. A second is long enough to read the name and short enough that the line stops calling a
 * finished tool the current activity before the model's next sentence lands; it is also the order of the client's
 * other grace period (the lost-connection notice waits 1.2 s before it appears).
 */
export const TOOL_LABEL_HOLD_MS = 1_000;

export interface WorkingMachineOptions {
	/** The clock, injectable so a test can advance a fast tool past its hold without sleeping. */
	now?: () => number;
}

export interface WorkingMachine {
	/**
	 * The line for `status`, with the memory of the tools this turn has already named.
	 *
	 * Call it for every status, and again when `holdRemainingMs` expires; the machine never schedules anything itself.
	 */
	label(status: AgentStatus | undefined): string | undefined;
	/** How long until a held tool name should be re-read with the same status, or `undefined` when it is settled. */
	holdRemainingMs(): number | undefined;
}

/**
 * A turn's working line, with the last tool it named held briefly.
 *
 * The line is the last activity, not a process list: while the turn is busy, it names the most recent tool call of the
 * round and keeps that name for `TOOL_LABEL_HOLD_MS` after the tool stops, so the next step being chosen does not
 * blank it. The name comes only from `runningTools`, so a tool that did not run cannot appear, and the memory is
 * dropped when `busy` goes false so one turn cannot leak into the next. `compacting context` and `retrying` are later
 * activity: they outrank the remembered tool and clear it.
 */
export function createWorkingMachine(options: WorkingMachineOptions = {}): WorkingMachine {
	const now = options.now ?? Date.now;
	let lastTool: string | undefined;
	/** When `lastTool` first appeared on the line; the hold is a minimum, not a dwell after every stop. */
	let namedAt = 0;
	let pendingUntil: number | undefined;
	/** The running names the previous status carried, so a re-run of the same tool still earns a fresh hold. */
	let previousRunning: readonly string[] = [];

	return {
		label(status) {
			pendingUntil = undefined;
			if (status === undefined || !status.busy) {
				lastTool = undefined;
				previousRunning = [];
				return undefined;
			}
			if (status.runStatus === "compacting" || status.runStatus === "retrying") {
				lastTool = undefined;
				previousRunning = status.runningTools;
				return status.runStatus === "compacting" ? "compacting context" : "retrying";
			}

			const running = status.runningTools;
			const named = latestTool(lastTool, running, previousRunning);
			if (named !== undefined) {
				// A name earns its hold when it starts or replaces another. A tool that keeps running keeps the hold it
				// already had, so a five-second `bash` does not add five seconds of afterglow when it stops.
				if (named !== lastTool || !previousRunning.includes(named)) {
					lastTool = named;
					namedAt = now();
				}
				previousRunning = running;
				return `working: ${named}`;
			}
			previousRunning = running;

			// No tool is running now. If one ran this turn and its name has not had its second on the line, keep it.
			if (lastTool !== undefined && now() - namedAt < TOOL_LABEL_HOLD_MS) {
				pendingUntil = namedAt + TOOL_LABEL_HOLD_MS;
				return `working: ${lastTool}`;
			}
			return "working";
		},
		holdRemainingMs() {
			return pendingUntil === undefined ? undefined : Math.max(0, pendingUntil - now());
		},
	};
}

/**
 * The tool to name: a name that was not running in the previous status is the newest call, and `runningToolNames`
 * lists a round in call order. With no new call, the tool last named stays while it still runs; if it finished while
 * older calls continue, the newest of those takes the line.
 */
function latestTool(
	lastTool: string | undefined,
	running: readonly string[],
	previous: readonly string[],
): string | undefined {
	for (let index = running.length - 1; index >= 0; index -= 1) {
		const name = running[index]!;
		if (!previous.includes(name)) return name;
	}
	if (lastTool !== undefined && running.includes(lastTool)) return lastTool;
	return running[running.length - 1];
}
