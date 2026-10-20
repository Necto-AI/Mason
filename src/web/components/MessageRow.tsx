/**
 * The rows of the reader's transcript.
 *
 * A user message and a sent message are the two things a person wrote or received; a hook row says what woke the
 * agent; a notice says a run failed, without the machine's reason. There is no trace, no tool row and no reasoning
 * here by construction — the server does not send them.
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

/** A trigger: the agent speaks first, so the reader is told what woke it. */
export function HookRow({ hookName, firedAt, payload }: { hookName: string; firedAt: string; payload?: string }) {
	const time = firedAt === "" ? "" : new Date(firedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return (
		<article className="message hook" data-testid="msg-hook">
			<div className="bubble">
				<div className="hook-head">
					<span className="hook-mark" aria-hidden="true">
						{"\u25c6"}
					</span>
					triggered {hookName}
					{time === "" ? null : <time className="hook-when">{time}</time>}
				</div>
				{payload === undefined || payload === "" ? null : <p className="step-block payload">{payload}</p>}
			</div>
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

/** A failed run, said in the reader's terms. The machine's error belongs to the trace, not to the chat. */
export function NoticeRow({ text }: { text: string }) {
	return (
		<div className="notice" data-testid="msg-notice">
			{text}
		</div>
	);
}
