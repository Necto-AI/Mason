/**
 * Who a submission comes from, and therefore where it waits.
 *
 * The origin is not a second field beside the submission: pi-durable already places every input as an entry kind,
 * and that kind is in the transcript. Admission is read from the kind, so the rule cannot drift from the history it
 * describes. The user may interrupt a running turn; nothing else may — a hook, a helper or a routine joins the back
 * of the line, and the running turn works through its batch first.
 */
import type { InputEntry } from "@earendil-works/pi-durable";

/** Where an input came from. `user` is the same human who owns the conversation. */
export type Origin = "user" | "hook" | "helper" | "routine";

/** The queue a busy conversation puts an input in. `reject` is the caller's own refusal, never a policy here. */
export type WhenBusy = "steer" | "followUp";

/** The entry kind an input of this origin is placed as; `undefined` is pi's default `pi.user`. */
export function entryKindFor(origin: Origin): string | undefined {
	switch (origin) {
		case "user":
			return undefined;
		case "hook":
			return "app.hook";
		case "helper":
			return "app.helper";
		case "routine":
			return "app.routine";
	}
}

/** The origin an entry kind came from; an unknown kind is someone's, and unknown means the user. */
export function originOfEntryKind(kind: string | undefined): Origin {
	switch (kind) {
		case "app.hook":
			return "hook";
		case "app.helper":
			return "helper";
		case "app.routine":
			return "routine";
		default:
			return "user";
	}
}

/**
 * The entry an input is placed as, or `undefined` for the default `pi.user`. `data` is what the transcript shows
 * about the trigger — a hook's name, a helper's conversation.
 */
export function entryFor(origin: Origin, data?: Readonly<Record<string, unknown>>): InputEntry | undefined {
	const kind = entryKindFor(origin);
	if (kind === undefined) return undefined;
	return data === undefined ? { kind } : { kind, data: { ...data } };
}

/**
 * Where an input waits when the conversation is busy. Only the user steers, and only when the client says so: a
 * `steer` from anywhere else is downgraded, because the alternative is a background trigger talking over the
 * person driving.
 */
export function whenBusyFor(origin: Origin, requested?: WhenBusy): WhenBusy {
	if (origin !== "user") return "followUp";
	return requested ?? "followUp";
}
