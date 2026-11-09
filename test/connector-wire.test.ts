/**
 * The connector wire, as the three numbers a pull request reads instead of taking somebody's word for: the bytes one
 * reply costs on the socket, the deliveries the outbox still owes when it is quiet, and the milliseconds a reply that
 * waited for a connector to come back takes to arrive.
 *
 * Every case drives the published SDK over a real socket against a real server, because the number has to be mason's
 * outbox and not a model of it. The bytes are the `deliver` argument with the per-call id replaced by a placeholder: the
 * id is `reply:<callId>` and the call id the provider mints has no fixed length, so the raw payload is not a number a
 * ceiling can hold.
 *
 * Bytes and the owed count are deterministic, so they gate the run. The milliseconds are printed and never fail it: a
 * spread that is the machine's is the reviewer's to read, not the build's to enforce.
 *
 * The numbers leave as lines in the log and, when `$GITHUB_STEP_SUMMARY` names a file, as one section in it — which is
 * how they reach the pull request without a workflow edit.
 */
import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { after, describe, it } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Delivery } from "mason-connector";
import { replyRecordOf } from "../src/server/replies.ts";
import { DELIVERY_ENTRY_KIND, REPLY_ENTRY_KIND } from "../src/shared/contract.ts";
import {
	connectConnector,
	entriesOf,
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
const measured: {
	deliveryBytes?: number;
	baseline?: number;
	owedAtQuiescence?: number;
	resumeMs?: number;
} = {};

/** The bytes one delivery costs on the socket: the `deliver` argument, with the per-call id normalised. */
function wireBytes(delivery: Delivery): number {
	return Buffer.byteLength(JSON.stringify({ ...delivery, deliveryId: PLACEHOLDER_ID }));
}

type Verdict = "ok" | "stale" | "regression";

/**
 * The size gate: a ceiling on the bytes one delivery costs, and the line the run prints for it.
 *
 * Above the baseline the reply grew, and the message carries both numbers so the regression is readable from the log
 * alone. Below it the gate passes and says `baseline-stale`, which is the cue to lower the number in the same change.
 */
function verdict(bytes: number, baseline: number): { readonly verdict: Verdict; readonly message: string } {
	if (bytes > baseline) {
		return { verdict: "regression", message: `wire: the reply wire grew: ${bytes} bytes, baseline ${baseline}` };
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
		assert.fail(`wire: no baseline: write ${BASELINE} with {"deliveryBytes": ${measured.deliveryBytes ?? 0}}`);
	}
	const value = (JSON.parse(raw) as { deliveryBytes?: unknown }).deliveryBytes;
	if (typeof value !== "number") assert.fail(`wire: ${BASELINE} carries no deliveryBytes`);
	return value;
}

/** What the transcript still owes: a reply with an address that no `app.delivery` entry acknowledges. */
async function owedCount(served: ServedConnector): Promise<number> {
	const entries = await entriesOf(served.server);
	const acknowledged = new Set<string>();
	for (const entry of entries) {
		const data = entry.data as { deliveryId?: unknown } | undefined;
		if (entry.kind !== DELIVERY_ENTRY_KIND || typeof data?.deliveryId !== "string") continue;
		acknowledged.add(data.deliveryId);
	}
	let owed = 0;
	for (const entry of entries) {
		const record = replyRecordOf(entry as unknown as EntryRecord);
		if (record?.address !== undefined && !acknowledged.has(record.deliveryId)) owed += 1;
	}
	return owed;
}

/** How many entries of one kind the transcript holds. */
async function countOf(served: ServedConnector, kind: string): Promise<number> {
	return (await entriesOf(served.server)).filter((entry) => entry.kind === kind).length;
}

/** The fixture, submitted from the target the operator declared, with the message id a person's client would mint. */
async function submitFixture(connected: Awaited<ReturnType<typeof connectConnector>>): Promise<void> {
	const outcome = await connected.connector.submit({
		origin: { ref: "team", messageId: "m1" },
		content: [{ type: "text", text: FIXTURE }],
	});
	assert.equal(outcome.status, "accepted", "the submission was claimed by mason");
}

describe("the connector wire", () => {
	it("costs a measured number of bytes, and leaves nothing owed", async () => {
		const served = await serveConnector({ steps: replyTurns([FIXTURE]) });
		try {
			let arrived = 0;
			let delivery: Delivery | undefined;
			const connected = await connectConnector(served, {
				handlers: {
					onDelivery: (params) => {
						arrived += 1;
						delivery = params;
						return { status: "delivered" };
					},
				},
			});
			try {
				await submitFixture(connected);
				await until(() => delivery !== undefined, "the delivery of the reply");
				await until(async () => (await countOf(served, DELIVERY_ENTRY_KIND)) === 1, "the acknowledgement");
				measured.deliveryBytes = wireBytes(delivery as Delivery);
				measured.owedAtQuiescence = await owedCount(served);
				measured.baseline = await baselineOf();
				assert.equal(arrived, 1, "one reply, delivered once");
				assert.equal(measured.owedAtQuiescence, 0, "the outbox owes nothing once the delivery is acknowledged");
				const gate = verdict(measured.deliveryBytes, measured.baseline);
				if (gate.verdict === "stale") console.log(`[wire] ${gate.message}`);
				assert.notEqual(gate.verdict, "regression", gate.message);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("arrives in a measured number of milliseconds after waiting for a connector", async () => {
		// Paced, so the reply is committed after the socket is gone: that is the wait this number is about.
		const served = await serveConnector({ steps: replyTurns([FIXTURE]), tokensPerSecond: 400 });
		try {
			const first = await connectConnector(served);
			try {
				await submitFixture(first);
			} finally {
				await first.close();
			}
			await until(async () => (await countOf(served, REPLY_ENTRY_KIND)) === 1, "the committed reply");
			assert.equal(await owedCount(served), 1, "the reply waited: there was no connector to deliver it");
			const started = Date.now();
			let arrived = 0;
			const connected = await connectConnector(served, {
				handlers: {
					onDelivery: () => {
						if (arrived === 0) measured.resumeMs = Date.now() - started;
						arrived += 1;
						return { status: "delivered" };
					},
				},
			});
			try {
				await until(() => arrived === 1, "the reply that waited");
				await until(async () => (await countOf(served, DELIVERY_ENTRY_KIND)) === 1, "the acknowledgement");
				assert.equal(await owedCount(served), 0, "the reply that waited is delivered and settled");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("fails on a bigger reply, with both numbers in the message", () => {
		// The reply the fixture would make at repeat(66), against the ceiling today: the arithmetic alone, no socket.
		const gate = verdict(1401, 1281);
		assert.equal(gate.verdict, "regression");
		assert.match(gate.message, /1401/);
		assert.match(gate.message, /1281/);
	});
});

after(async () => {
	if (measured.deliveryBytes !== undefined) {
		console.log(`[wire] delivery-bytes ${measured.deliveryBytes} baseline ${measured.baseline ?? "none"}`);
	}
	if (measured.owedAtQuiescence !== undefined) {
		console.log(`[wire] owed-at-quiescence ${measured.owedAtQuiescence}`);
	}
	if (measured.resumeMs !== undefined) console.log(`[wire] resume-ms ${measured.resumeMs}`);

	const rows: string[] = [];
	if (measured.deliveryBytes !== undefined && measured.baseline !== undefined) {
		const gate = verdict(measured.deliveryBytes, measured.baseline);
		rows.push(`| bytes per delivery | ${measured.deliveryBytes} | ≤ ${measured.baseline} | ${gate.verdict} |`);
	}
	if (measured.owedAtQuiescence !== undefined) {
		const owed = measured.owedAtQuiescence;
		rows.push(`| deliveries owed at quiescence | ${owed} | 0 | ${owed === 0 ? "ok" : "owed"} |`);
	}
	if (measured.resumeMs !== undefined) {
		rows.push(`| ms to deliver a reply that waited | ${measured.resumeMs} | reported only | reported |`);
	}
	if (SUMMARY === undefined || rows.length === 0) return;
	const section = ["### Connector wire", "", "| number | value | expectation | verdict |", "|---|---|---|---|"];
	await appendFile(SUMMARY, `${[...section, ...rows].join("\n")}\n\n`);
});
