/**
 * The generic event door: one path, one envelope, one signature.
 *
 * An integration is a service (ADR-0003), so the vendor's payload shape stops in the container that understands the
 * vendor. What arrives here has already been understood: a versioned envelope whose `payload` is a string written for a
 * person to read. The route in `main.ts` owns the request; this file owns the two decisions it makes about the bytes —
 * whether the signature is the sender's, and whether the envelope is one mason can act on — so both are pure and can be
 * tested without a server or a secret.
 *
 * The envelope is a public contract before the first third-party integration ships. `v` names the version being spoken,
 * and one mason does not know is a sender's bug, refused rather than guessed at. `id` is the delivery's identity, which
 * is why no table of seen ids exists: it becomes the fire's request id, and the durable log never forgets one, so a
 * redelivery after a restart — or days later — is the same fire. `kind` is a label for the log, never a dispatch key:
 * one trigger, one hook. `payload` is text, refused when it is over the cap rather than truncated, because a truncated
 * event is a lie about what happened.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** How many bytes a delivery may be: an envelope carries a paragraph, and the cap bounds what a sender can buffer. */
export const EVENT_BODY_MAX_BYTES = 256 * 1024;

/** The one path a trigger answers on: `/api/events/<integration>` (main.ts). */
export const EVENTS_PATH = "/api/events/";

/** `sha256=<hex hmac-sha256 of the raw body>`, the shape GitHub already sends (`verifyGithubSignature`). */
export const EVENT_SIGNATURE_HEADER = "x-mason-signature";

/** A `payload` is a paragraph a person reads, not a document: far more than a real event, far less than a prompt can hold. */
const PAYLOAD_MAX = 2_000;

/** Long enough for a provider's event id, short enough that the key stays a key. */
const ID_MAX = 200;

/** A short token: the log line and the prompt's label, nothing structural. */
const KIND_MAX = 64;

/** The v1 envelope, checked. Unknown keys are ignored: a sender may add fields before mason knows them. */
export interface EventEnvelope {
	readonly v: 1;
	readonly id: string;
	readonly kind: string;
	readonly payload: string;
}

/**
 * Whether the header signs exactly these bytes with this secret.
 *
 * Over the raw bytes, before JSON parsing, exactly as `verifyGithubSignature` does: re-serialising changes whitespace
 * and key order, and the signature would then be over something the sender never signed. Comparison is constant-time,
 * because a check that leaks how far it got can be guessed a byte at a time. A missing or malformed header is simply
 * not the sender's signature; the caller learns nothing beyond a `401`.
 */
export function verifySignature(secret: string, raw: Buffer, header: string | undefined): boolean {
	if (header === undefined || !header.startsWith("sha256=")) return false;
	const claimed = Buffer.from(header.slice("sha256=".length), "hex");
	if (claimed.length !== 32) return false;
	const expected = createHmac("sha256", secret).update(raw).digest();
	return timingSafeEqual(claimed, expected);
}

/**
 * The v1 envelope, or an error naming the field that made it one mason cannot act on.
 *
 * The error is for the sender, so it says which field and what the rule is; the route answers `400` with it and never
 * with a partially-read event. A body that is not a JSON object is an error, not an empty envelope: a sender that posts
 * a form or an array has a bug, and acknowledging it would look like a delivery.
 */
export function readEnvelope(raw: Buffer): EventEnvelope | { error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.toString("utf8"));
	} catch {
		return { error: "body is not JSON" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { error: "body is not a JSON object" };
	}
	const fields = parsed as Record<string, unknown>;
	if (fields.v !== 1) return { error: '"v" must be the integer 1' };
	const id = fields.id;
	if (typeof id !== "string" || id === "") return { error: '"id" must be a non-empty string' };
	if (id.length > ID_MAX) return { error: `"id" is ${id.length} characters; the cap is ${ID_MAX}` };
	const kind = fields.kind;
	if (typeof kind !== "string" || kind === "") return { error: '"kind" must be a non-empty string' };
	if (kind.length > KIND_MAX) return { error: `"kind" is ${kind.length} characters; the cap is ${KIND_MAX}` };
	const payload = fields.payload;
	if (typeof payload !== "string") return { error: '"payload" must be a string' };
	if (payload.length > PAYLOAD_MAX) {
		return {
			error: `"payload" is ${payload.length} characters; the cap is ${PAYLOAD_MAX}, and an over-long event is refused rather than truncated`,
		};
	}
	return { v: 1, id, kind, payload };
}
