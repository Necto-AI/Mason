/** One tool call: its explicit status, its live output while it runs, and its settled result. */
import type { JsonObject } from "../view-types.ts";

export interface ToolRowProps {
	readonly name: string;
	readonly callId: string;
	readonly arguments?: JsonObject;
	readonly status: "pending" | "running" | "done" | "error";
	/** Retained output while the call runs. */
	readonly output?: string;
	/** What the model saw when the call settled. */
	readonly result?: string;
	readonly durationMs?: number;
	/** Content rendered under the row, such as a generated widget. */
	readonly children?: React.ReactNode;
}

function summary(name: string, args: JsonObject | undefined): string | undefined {
	if (args === undefined) return undefined;
	const first = (key: string): string | undefined => (typeof args[key] === "string" ? (args[key] as string) : undefined);
	if (name === "bash") return first("command");
	const path = first("path");
	if (path !== undefined) return path;
	if (name === "generateSandboxedUi") return "inline widget";
	return undefined;
}

/** `call_00_ET_DDuKNzVWyiEWF7PtpPnL68589` reads better as `…68589`; the full id stays in the title. */
function shortId(callId: string): string {
	return callId.length <= 10 ? callId : `…${callId.slice(-6)}`;
}

export function ToolRow({ name, callId, arguments: args, status, output, result, durationMs, children }: ToolRowProps) {
	const detail = summary(name, args);
	const live = status === "running" || status === "pending" ? output : undefined;
	// Both a finished and a failed call have a result; a failed one shows it without needing a click.
	const text = status === "done" || status === "error" ? result : undefined;
	const failed = status === "error" && (output === undefined || output === "") ? text : undefined;
	return (
		<div className="tool" data-testid={`tool-${name}`}>
			<div className="tool-head">
				<span className={`badge badge-${status === "error" ? "error" : status}`} data-testid={`tool-status-${name}`}>
					{`[TOOL: ${name} • status=${status}]`}
				</span>
				{detail === undefined ? null : <code className="tool-detail">{detail}</code>}
				{callId === "" ? null : (
					<span className="tool-id" title={callId}>
						{shortId(callId)}
					</span>
				)}
				{durationMs === undefined ? null : <span className="tool-id">{Math.round(durationMs)} ms</span>}
			</div>
			{live === undefined || live === "" ? null : (
				<pre className="tool-output" data-testid={`tool-output-${name}`}>
					{live}
				</pre>
			)}
			{failed === undefined || failed === "" ? null : (
				<pre className="tool-output tool-output-error" data-testid={`tool-error-${name}`}>
					{failed}
				</pre>
			)}
			{text === undefined || text === "" || failed !== undefined ? null : (
				<details className="tool-result">
					<summary>result</summary>
					<pre data-testid={`tool-result-${name}`}>{text}</pre>
				</details>
			)}
			{children}
		</div>
	);
}
