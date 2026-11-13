/**
 * The connector wire, as the numbers a pull request reads instead of taking somebody's word for: the bytes one committed
 * reply row costs in the `conversation` state, and the milliseconds a client that connects after the reply takes to hold
 * it.
 *
 * Every case drives a real Chord client over a real socket against a real server, because the number has to be mason's
 * read model and not a model of it. The row is measured with the per-call id replaced by a placeholder: the id is
 * `reply:<callId>` and the call id the provider mints has no fixed length, so the raw row is not a number a ceiling can
 * hold.
 *
 * Bytes are deterministic, so they gate the run. The milliseconds are printed and never fail it: a spread that is the
 * machine's is the reviewer's to read, not the build's to enforce.
 *
 * The numbers leave as lines in the log and, when `$GITHUB_STEP_SUMMARY` names a file, as one section in it — which is
 * how they reach the pull request without a workflow edit.
 */
import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { after, describe, it } from "node:test";
import type { StateEvent } from "@earendil-works/chord";
import { apply } from "@earendil-works/chord/delta";
import type { ConversationState } from "mason-protocol";
import { REPLY_ENTRY_KIND } from "../src/shared/contract.ts";
import {
	connectConnector,
	holdPeer,
	replyTurns,
	type ServedConnector,
	serveConnector,
	until,
} from "./support/connector.ts";

/** The answer every case measures: one fixed length, so a number that moves is the wire and not the words. */
const FIXTURE = "Here is the answer. ".repeat(60).trim();

/** Where the call id goes before measuring. Its replacement, not its value: the id is per call and has no fixed length. */
const PLACEHOLDER_ID = "reply:<call-id>";

/** The ceiling, committed: above it the run fails, below it the run passes and says the number can come down. */
const BASELINE = "test/connector-wire-baseline.json";
const BASELINE_FILE = new URL(BASELINE, new URL("../", import.meta.url));

/** The job summary, when CI gives the run one. */
const SUMMARY = process.env.GITHUB_STEP_SUMMARY;

/** What this run measured. Each case records a row before it asserts on it, so a failing run still prints the numbers. */
const measured: { rowBytes?: number; baseline?: number; resumeMs?: number } = {};

/** The bytes one committed reply row costs on the wire, with the per-call id normalised. */
function rowBytes(row: { id: string; text: string }): number {
	return Buffer.byteLength(JSON.stringify({ kind: "delivered", id: PLACEHOLDER_ID, text: row.text }));
}

type Verdict = "ok" | "stale" | "regression";

/**
 * The size gate: a ceiling on the bytes one row costs, and the line the run prints for it.
 *
 * Above the baseline the row grew, and the message carries both numbers so the regression is readable from the log alone.
 * Below it the gate passes and says `baseline-stale`, which is the cue to lower the number in the same change.
 */
function verdict(bytes: number, baseline: number): { readonly verdict: Verdict; readonly message: string } {
	if (bytes > baseline) {
		return { verdict: "regression", message: `wire: the reply row grew: ${bytes} bytes, baseline ${baseline}` };
	}
	if (bytes < baseline) return { verdict: "stale", message: `baseline-stale: ${bytes} bytes, baseline ${baseline}` };
	return { verdict: "ok", message: `${bytes} bytes, baseline ${baseline}` };
}

/** The committed baseline, or a failure that names the file to write: a missing baseline is not a pass. */
async function baselineOf(): Promise<number> {
	let raw: string;
	try {
		raw = await readFile(BASELINE_FILE, "utf8");
	} catch {
		assert.fail(`wire: no baseline: write ${BASELINE} with {"rowBytes": ${measured.rowBytes ?? 0}}`);
	}
	const value = (JSON.parse(raw) as { rowBytes?: unknown }).rowBytes;
	if (typeof value !== "number") assert.fail(`wire: ${BASELINE} carries no rowBytes`);
	return value;
}

/** How many entries of one kind the transcript holds. */
async function countOf(served: ServedConnector, kind: string): Promise<number> {
	const entries = await served.server.runtime.conversation();
	const page = await entries.entries({}, 1000, undefined, { signal: AbortSignal.timeout(5_000) } as never);
	return (page.items as unknown as { kind: string }[]).filter((entry) => entry.kind === kind).length;
}

/** The state a client holds after every frame it has seen: a snapshot replaces, a diff is applied to what is held. */
function heldState(frames: readonly StateEvent<ConversationState>[]): ConversationState | undefined {
	let state: ConversationState | undefined;
	for (const frame of frames) {
		state = frame.type === "ops" ? (apply(structuredClone(state), frame.ops) as ConversationState) : frame.value;
	}
	return state;
}

/** The committed reply rows of a state, oldest first. */
function committedRows(state: ConversationState | undefined): Array<{ id: string; text: string }> {
	return (state?.transcript ?? []).flatMap((row) =>
		row.kind === "delivered" && row.streaming !== true ? [{ id: row.id, text: row.text }] : [],
	);
}

/** The fixture, submitted over the socket under test with the message id a person's client would mint. */
async function submitFixture(peer: Awaited<ReturnType<typeof holdPeer>>, appendId = "wire-1"): Promise<void> {
	const outcome = await peer.ref.append({
		type: "submission",
		appendId,
		origin: { ref: "chat", messageId: "m1" },
		content: [{ type: "text", text: FIXTURE }],
	});
	assert.equal(outcome.outcome, "accepted", "the submission was claimed by mason");
}

describe("the connector wire", () => {
	it("costs a measured number of bytes per reply row", async () => {
		const served = await serveConnector({ steps: replyTurns([FIXTURE]) });
		try {
			const heldPeer = await holdPeer(served);
			try {
				await submitFixture(heldPeer);
				await until(async () => (await countOf(served, REPLY_ENTRY_KIND)) === 1, "the committed reply");
				await until(() => committedRows(heldState(heldPeer.frames)).length === 1, "the row in the state");
				const rows = committedRows(heldState(heldPeer.frames));
				assert.equal(rows.length, 1, "one reply row for the turn");
				measured.rowBytes = rowBytes(rows[0] as { id: string; text: string });
				measured.baseline = await baselineOf();
				const gate = verdict(measured.rowBytes, measured.baseline);
				if (gate.verdict === "stale") console.log(`[wire] ${gate.message}`);
				assert.notEqual(gate.verdict, "regression", gate.message);
			} finally {
				await heldPeer.close();
			}
		} finally {
			await served.close();
		}
	});

	it("hands a client that connects after the reply the same row, in a measured number of milliseconds", async () => {
		// Paced, so the reply is committed after the submitting socket is gone: that is the wait this number is about.
		const served = await serveConnector({ steps: replyTurns([FIXTURE]), tokensPerSecond: 400 });
		try {
			const first = await connectConnector(served);
			try {
				await first.connector.submit({
					origin: { ref: "chat", messageId: "m1" },
					content: [{ type: "text", text: FIXTURE }],
					appendId: "wire-2",
				});
			} finally {
				await first.close();
			}
			await until(async () => (await countOf(served, REPLY_ENTRY_KIND)) === 1, "the committed reply");
			const started = Date.now();
			const heldPeer = await holdPeer(served);
			try {
				await until(() => committedRows(heldState(heldPeer.frames)).length === 1, "the row a later client holds");
				measured.resumeMs = Date.now() - started;
				assert.equal(
					committedRows(heldState(heldPeer.frames))[0]?.text,
					FIXTURE,
					"the row a client that connected later holds is the reply",
				);
			} finally {
				await heldPeer.close();
			}
		} finally {
			await served.close();
		}
	});

	it("fails on a bigger row, with both numbers in the message", async () => {
		// The arithmetic alone, no socket: one byte over the committed ceiling is a regression, and the message names both
		// numbers so the log reads without the file open.
		const baseline = await baselineOf();
		const gate = verdict(baseline + 1, baseline);
		assert.equal(gate.verdict, "regression");
		assert.match(gate.message, new RegExp(`${baseline + 1} bytes`));
		assert.match(gate.message, new RegExp(`baseline ${baseline}`));
	});
});

after(async () => {
	if (measured.rowBytes !== undefined) {
		console.log(`[wire] row-bytes ${measured.rowBytes} baseline ${measured.baseline ?? "none"}`);
	}
	if (measured.resumeMs !== undefined) console.log(`[wire] resume-ms ${measured.resumeMs}`);

	const rows: string[] = [];
	if (measured.rowBytes !== undefined && measured.baseline !== undefined) {
		const gate = verdict(measured.rowBytes, measured.baseline);
		rows.push(`| bytes per reply row | ${measured.rowBytes} | ≤ ${measured.baseline} | ${gate.verdict} |`);
	}
	if (measured.resumeMs !== undefined) {
		rows.push(`| ms to hand a later client the row | ${measured.resumeMs} | reported only | reported |`);
	}
	if (SUMMARY === undefined || rows.length === 0) return;
	const section = ["### Connector wire", "", "| number | value | expectation | verdict |", "|---|---|---|---|"];
	await appendFile(SUMMARY, `${[...section, ...rows].join("\n")}\n\n`);
});
