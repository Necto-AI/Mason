/**
 * Tool rows: the icon-led line for one tool call and the small formatters behind it. Ported from apiary's
 * `packages/web/src/tools.ts` with the DOM left behind — the React row renders from these strings.
 */

/** How long a tool took, in the trace's hover label. */
export function stepDuration(ms: number): string {
	const seconds = Math.max(0.1, ms / 1000);
	return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/** One line of a tool call, in the CLI's `bash: ls -la` shape. */
export function summarizeArgs(args: unknown): string {
	if (args === null || args === undefined) return "";
	if (typeof args !== "object") return typeof args === "string" ? singleLine(args) : "";
	const record = args as Record<string, unknown>;
	const first = record.command ?? record.path ?? record.pattern ?? record.query ?? Object.values(record)[0];
	return typeof first === "string" ? singleLine(first) : "";
}

export function singleLine(text: string, max = 100): string {
	const line = text.split("\n").find((part) => part.trim() !== "")?.trim() ?? "";
	return line.length > max ? `${line.slice(0, max)}\u2026` : line;
}

/** The arguments of a row, as the expanded block shows them. */
export function pretty(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

export const SVG_ATTRS =
	'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

/** One glyph per standard tool; anything else gets the general wrench. */
const ICONS: Record<string, string> = {
	bash: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
	read: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/>',
	write:
		'<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
	edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
	ls: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
	grep: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
	glob: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
	find: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
	web: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
	// The widget renderer: a frame with a spark, so a generated UI reads as one.
	generateSandboxedUi:
		'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="m9 14 2 2-2 2"/><path d="M13 18h3"/>',
	general:
		'<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
};

export function iconFor(tool: string): string {
	if (tool in ICONS) return ICONS[tool];
	if (tool.startsWith("web")) return ICONS.web;
	return ICONS.general;
}

/** Quiet state glyphs: a check when it is done, a triangle only when it failed. */
export const STATE_ICONS = {
	check: '<path d="M20 6 9 17l-5-5"/>',
	alert:
		'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
} as const;

/** Which glyph a row trails: nothing while it may still run, then the outcome. */
export function stateIconFor(state: "pending" | "running" | "done" | "error"): string | undefined {
	if (state === "done") return STATE_ICONS.check;
	if (state === "error") return STATE_ICONS.alert;
	return undefined;
}
