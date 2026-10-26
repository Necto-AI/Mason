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
 * and one mason does not know is a sender's bug, refused rather than guessed at. `id` is the envelope id and the fire's
 * identity, which is why no table of seen ids exists: it becomes the fire's request id, and the durable log never
 * forgets one, so a redelivery after a restart — or days later — is the same fire. `kind` is a label for the log, never
 * a dispatch key: one trigger, one hook. `payload` is text, refused when it is over the cap rather than truncated,
 * because a truncated event is a lie about what happened.
 *
 * Two of these reach the accept log, so both are held to one line: `kind` is a token, and `id`, which is whatever opaque
 * key a provider chose, may not carry a control character — a newline in it would forge the rest of that line.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** The one path a trigger answers on: `/api/events/<integration>` (main.ts). */
export const EVENTS_PATH = "/api/events/";

/** `sha256=<hex hmac-sha256 of the raw body>`, the shape GitHub already sends: a header's name is a sender's choice, its
 * form is mason's. */
export const EVENT_SIGNATURE_HEADER = "x-mason-signature";

/** A `payload` is a paragraph a person reads, not a document: far more than a real event, far less than a prompt can hold. */
const PAYLOAD_MAX = 2_000;

/** Long enough for a provider's event id, short enough that the key stays a key. */
const ID_MAX = 200;

/**
 * The bytes a log line or a terminal acts on rather than shows, C0 and DEL. An `id` may be a provider's opaque key, so it
 * is free text within its cap — but whatever it holds ends up in the accept log verbatim, and a carriage return would
 * rewrite the line in front of it.
 */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * A short token, not free text: the kind is the accept log's label and the prompt's one line, so a newline or a space in
 * it would split one label into two and forge the rest of a line. Letters, digits and `.` `_` `:` `-`, the first character
 * a letter or a digit, at most 64 — enough for `issue.opened`, `push` or `chat.message`, and nothing that needs quoting.
 */
const KIND_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

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
 * Over the raw bytes, before JSON parsing: re-serialising changes whitespace and key order, and the signature would then
 * be over something the sender never signed. Comparison is constant-time, because a check that leaks how far it got can
 * be guessed a byte at a time. A missing or malformed header is simply not the sender's signature; the caller learns
 * nothing beyond a `401`. One implementation, because two copies of a signature check are two chances for one of them to
 * drift: a header's name is the sender's, the bytes and the HMAC are mason's.
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
	// Before the cap, because this is the rule that keeps one delivery one line: the id is interpolated into the accept log
	// as-is, and a newline in it would let a sender forge entries in it.
	if (CONTROL_CHARACTER.test(id)) {
		return { error: '"id" must be one line: it holds a control character, and the accept log prints it as-is' };
	}
	if (id.length > ID_MAX) return { error: `"id" is ${id.length} characters; the cap is ${ID_MAX}` };
	const kind = fields.kind;
	if (typeof kind !== "string" || !KIND_TOKEN.test(kind)) {
		return {
			error:
				'"kind" must be a short token — letters, digits and "." "_" ":" "-", starting with a letter or a digit, at most 64 characters — such as "issue.opened", "push" or "chat.message", with no spaces or newlines',
		};
	}
	const payload = fields.payload;
	if (typeof payload !== "string") return { error: '"payload" must be a string' };
	if (payload.length > PAYLOAD_MAX) {
		return {
			error: `"payload" is ${payload.length} characters; the cap is ${PAYLOAD_MAX}, and an over-long event is refused rather than truncated`,
		};
	}
	return { v: 1, id, kind, payload };
}
