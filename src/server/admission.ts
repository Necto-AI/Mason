/**
 * Who a submission comes from, and therefore where it waits.
 *
 * The origin is not a second field beside the submission: pi-durable already places every input as an entry kind, and
 * that kind is in the transcript. Admission reads the origin from the kind, so the rule cannot drift from the history
 * it describes. Two sources exist today — the user and an event hook — and the one rule between them is that a trigger
 * source never steers: only the user may interrupt a running turn.
 */
import type { InputEntry, JsonObject } from "@earendil-works/pi-durable";
import { HOOK_ENTRY_KIND } from "../shared/contract.ts";

/** Where an input came from. `user` is the same human who owns the conversation; `hook` is an event hook firing. */
export type Origin = "user" | "hook";

/** The queue a busy conversation puts an input in. `reject` is the caller's own refusal, never a policy here. */
export type WhenBusy = "steer" | "followUp" | "reject";

/** The entry kind an input of this origin is placed as; `undefined` is pi's default, `pi.user`. */
export function entryKindFor(origin: Origin): string | undefined {
	switch (origin) {
		case "user":
			return undefined;
		case "hook":
			return HOOK_ENTRY_KIND;
	}
}

/** The entry an input is placed as, or `undefined` for the default `pi.user`. `data` is what the transcript shows
 * about the trigger — for a hook, its id, name, payload and fire time. */
export function entryFor(origin: Origin, data?: JsonObject): InputEntry | undefined {
	const kind = entryKindFor(origin);
	if (kind === undefined) return undefined;
	return data === undefined ? { kind } : { kind, data: { ...data } };
}

/**
 * Where an input waits when the conversation is busy: only the user steers, and a `steer` asked for by any other
 * origin is downgraded to a `followUp`, because the alternative is a background trigger talking over the person
 * driving. A user's own `reject` passes through unchanged — that is the caller refusing, not a placement policy.
 */
export function whenBusyFor(origin: Origin, requested?: WhenBusy): WhenBusy | undefined {
	if (origin !== "user") return "followUp";
	return requested;
}
