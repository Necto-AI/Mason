/**
 * What the agent is doing, in one line, for a reader who is not shown the machine.
 *
 * The client receives a status and a list of tool names — never arguments, never output — so this is the whole of the
 * "working" surface: a verb and, while tools run, their names. Reasoning is not a stage a person can act on, so the
 * line says that work is happening and what kind, and stops there.
 */
import type { AgentStatus } from "../../shared/contract.ts";

/** The line under the transcript while a turn runs; `undefined` when nothing is running. */
export function workingLabel(status: AgentStatus | undefined): string | undefined {
	if (status === undefined) return undefined;
	if (!status.busy) return undefined;
	const tools = status.runningTools;
	switch (status.runStatus) {
		case "running_tools":
			return tools.length === 0 ? "working" : `working: ${tools.join(", ")}`;
		case "generating":
			return "working";
		case "compacting":
			return "compacting context";
		case "retrying":
			return "retrying";
		case "idle":
			// A run is alive but has not reached a stage yet: the input landed and the next step is being chosen.
			return "working";
	}
}
