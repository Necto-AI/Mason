/**
 * A behaviour scenario: what the agent is told, what its tools answer, and what must be true afterwards.
 *
 * Files, not prose. A scenario is small enough to read, and its assertions are the same ones a person would apply to a
 * transcript — did it act, did it report once, did it check before claiming, did it remember.
 */
export interface Scenario {
	readonly id: string;
	readonly about: string;
	/** Files to plant in the agent's home before the run, relative to it (`profile.md`, `skills/x/SKILL.md`). */
	readonly home?: Record<string, string>;
	/** What each stub tool answers. `bash` matches a substring of the command; `read` matches the path exactly. */
	readonly stubs?: {
		readonly bash?: readonly { readonly match: string; readonly result: string }[];
		readonly read?: readonly { readonly path: string; readonly result: string }[];
	};
	/** The turns, oldest first. A turn with `hook` is submitted exactly as a fired hook submits it. */
	readonly turns: readonly {
		readonly text?: string;
		readonly hook?: { readonly name: string; readonly description?: string; readonly payload?: string };
	}[];
	readonly expect: Expected;
}

export interface Expected {
	/** How often each tool was called. Absent tool: unconstrained; listed tool: bounds are honoured. */
	readonly calls?: Record<string, { readonly min?: number; readonly max?: number }>;
	/** These tools must never be called. */
	readonly absentTools?: readonly string[];
	/** `then` must not be called before `tool`: "it checked before it claimed". */
	readonly before?: readonly { readonly tool: string; readonly then: string }[];
	/** Substrings the delivered messages must contain, case-insensitive. */
	readonly text?: readonly string[];
	/** Substrings the delivered messages must not contain, case-insensitive — filler, permission-asking. */
	readonly absentText?: readonly string[];
	/** Regexes today's log file must match: "it wrote the fact down". */
	readonly log?: readonly string[];
	/** A widget must reach the reader, built with `css` before `html`. */
	readonly widget?: boolean;
	/** The run must not send more prompt tokens than this. */
	readonly maxInputTokens?: number;
	/** Tool calls spent on work — everything except `send_to_user`, which is the delivery channel, not effort. */
	readonly maxTools?: number;
}

/** One thing that was checked, and whether it held. */
export interface Check {
	readonly name: string;
	readonly pass: boolean;
	readonly detail: string;
}

/** Everything a run leaves behind: what the reader saw, what the agent did, what it cost. */
export interface Trace {
	readonly scenario: string;
	readonly model: string;
	readonly delivered: string[];
	readonly notices: string[];
	readonly toolCalls: { name: string; args: unknown }[];
	readonly widgets: number;
	readonly widgetArguments: Record<string, unknown> | undefined;
	readonly inputTokens: number;
	readonly outputTokens: number;
	/** One entry per submitted turn: how many messages the reader got, and how the turn settled. */
	readonly turns: { readonly delivered: number; readonly status: string }[];
	readonly finished: boolean;
	readonly error?: string;
}

export function check(trace: Trace, expected: Expected, logText: string): Check[] {
	const checks: Check[] = [];
	const add = (name: string, pass: boolean, detail = ""): void => {
		checks.push({ name, pass, detail });
	};
	const calls = countCalls(trace);
	const delivered = trace.delivered.join("\n").toLowerCase();

	for (const [tool, bounds] of Object.entries(expected.calls ?? {})) {
		const count = calls.get(tool) ?? 0;
		const ok = (bounds.min === undefined || count >= bounds.min) && (bounds.max === undefined || count <= bounds.max);
		add(`calls.${tool}`, ok, `${count} (expected ${bounds.min ?? 0}..${bounds.max ?? "∞"})`);
	}
	for (const tool of expected.absentTools ?? []) {
		const count = calls.get(tool) ?? 0;
		add(`absent.${tool}`, count === 0, `${count} call(s)`);
	}
	for (const rule of expected.before ?? []) {
		const first = trace.toolCalls.findIndex((call) => call.name === rule.tool);
		const later = trace.toolCalls.findIndex((call) => call.name === rule.then);
		add(
			`before.${rule.tool}<${rule.then}`,
			first !== -1 && later !== -1 && first < later,
			first === -1
				? `${rule.tool} was never called`
				: later === -1
					? `${rule.then} was never called`
					: `${rule.tool} at ${first}, ${rule.then} at ${later}`,
		);
	}
	for (const needle of expected.text ?? []) {
		add(`text.${needle}`, delivered.includes(needle.toLowerCase()), delivered === "" ? "nothing delivered" : "");
	}
	for (const needle of expected.absentText ?? []) {
		add(`absentText.${needle}`, !delivered.includes(needle.toLowerCase()));
	}
	for (const pattern of expected.log ?? []) {
		add(`log.${pattern}`, new RegExp(pattern, "im").test(logText));
	}
	if (expected.widget === true) {
		const keys = Object.keys(trace.widgetArguments ?? {});
		const css = keys.indexOf("css");
		const html = keys.indexOf("html");
		add("widget.rendered", trace.widgets > 0, `${trace.widgets} widget(s)`);
		add("widget.order", css !== -1 && html !== -1 && css < html, keys.join(", ") || "no arguments");
	}
	if (expected.maxTools !== undefined) {
		const work = trace.toolCalls.filter((call) => call.name !== "send_to_user").length;
		add("maxTools", work <= expected.maxTools, `${work} work call(s) <= ${expected.maxTools}`);
	}
	if (expected.maxInputTokens !== undefined) {
		add(
			"maxInputTokens",
			trace.inputTokens <= expected.maxInputTokens,
			`${trace.inputTokens} <= ${expected.maxInputTokens}`,
		);
	}
	for (const [index, turn] of trace.turns.entries()) {
		add(`turn.${index + 1}.delivered`, turn.delivered > 0, `${turn.delivered} message(s), ${turn.status}`);
	}
	add("finished", trace.finished, trace.error ?? "");
	return checks;
}

function countCalls(trace: Trace): Map<string, number> {
	const calls = new Map<string, number>();
	for (const call of trace.toolCalls) calls.set(call.name, (calls.get(call.name) ?? 0) + 1);
	return calls;
}
