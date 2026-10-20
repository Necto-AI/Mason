/**
 * The rows of the reader's transcript.
 *
 * A user message and a sent message are the two things a person wrote or received; a notice says a run failed, without
 * the machine's reason. There is no trace, no tool row, no reasoning and no trigger banner here by construction — the
 * server does not send them, so a proactive turn is simply the message the agent sent.
 */
import { useMemo } from "react";
import { renderMarkdown } from "../lib/markdown.ts";
import { StreamText } from "../lib/stream-text.tsx";

/** Markdown the model already finished writing. */
function MarkdownText({ text }: { text: string }) {
	const html = useMemo(() => renderMarkdown(text), [text]);
	return <div className="text markdown" data-testid="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function UserRow({ text }: { text: string }) {
	return (
		<article className="message user" data-testid="msg-user">
			<div className="bubble">{text}</div>
		</article>
	);
}

/** A message the agent sent: the only text it wrote that the reader was meant to read. */
export function DeliveredRow({ text, failed, streaming }: { text: string; failed: boolean; streaming?: boolean }) {
	// The message is written by the model while the call streams: the tail fades in, then it is markdown.
	const Text = streaming === true ? StreamText : MarkdownText;
	return (
		<article className="message assistant" data-failed={failed || undefined}>
			<div className={`bubble delivered${failed ? " failed" : ""}`} data-testid="msg-delivered">
				<Text text={text} />
				{failed ? (
					<div className="delivery-failed" data-testid="msg-delivered-failed">
						This message may not have reached you.
					</div>
				) : null}
			</div>
		</article>
	);
}

/**
 * The agent working: a bubble that says what it is doing, with three dots pulsing.
 *
 * It is not a transcript row and is never stored — it is derived from the status, so it exists exactly while a turn
 * runs and disappears the moment the turn ends. Nothing about the work stays in the chat afterwards.
 */
export function WorkingRow({ label }: { label: string }) {
	return (
		<article className="message working" data-testid="working" aria-live="polite">
			<div className="bubble working-bubble">
				<span className="working-label">{label}</span>
				<span className="working-dots" aria-hidden="true">
					<i />
					<i />
					<i />
				</span>
			</div>
		</article>
	);
}

/** A failed run, said in the reader's terms. The machine's error belongs to the trace, not to the chat. */
export function NoticeRow({ text }: { text: string }) {
	return (
		<div className="notice" data-testid="msg-notice">
			{text}
		</div>
	);
}
