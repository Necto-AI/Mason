/**
 * Streaming answer text, ported from sibling's `packages/web/src/stream.ts` as a component: the settled part is
 * re-rendered as markdown; what just arrived fades in as a tail, and any rewrite (not an append) re-renders
 * whole with no animation.
 *
 * The `.settled` box holds no React children: it is filled imperatively, so React never tries to reconcile a
 * node the markdown render replaced.
 */
import { useEffect, useRef } from "react";
import { renderMarkdown } from "./markdown.ts";

export interface StreamTextProps {
	readonly text: string;
}

/** Put the tail at the end of the last block, so it flows inline. */
function placeTail(settled: HTMLElement, tail: HTMLElement): void {
	const blocks = settled.children;
	const last = blocks[blocks.length - 1];
	if (last !== undefined && /^(P|LI|H[1-4]|UL|OL|BLOCKQUOTE)$/.test(last.tagName)) last.append(tail);
	else settled.append(tail);
}

function reveal(parent: HTMLElement, text: string): void {
	const span = document.createElement("span");
	span.className = "w-fade";
	span.textContent = text;
	parent.append(span);
}

export function StreamText({ text }: StreamTextProps) {
	const settled = useRef<HTMLDivElement | null>(null);
	const tail = useRef<HTMLSpanElement | null>(null);
	const source = useRef("");

	useEffect(() => {
		const box = settled.current;
		if (box === null) return;
		const shown = source.current + (tail.current?.textContent ?? "");
		if (shown !== "" && text.startsWith(shown)) {
			// An append: re-render the settled markdown and fade the delta in as the new tail.
			source.current = shown;
			box.innerHTML = renderMarkdown(shown);
			const fresh = document.createElement("span");
			fresh.className = "tail";
			const delta = text.slice(shown.length);
			if (delta.length <= 40) reveal(fresh, delta);
			else for (const word of delta.match(/\S+ ?/g) ?? []) reveal(fresh, word);
			tail.current = fresh;
			placeTail(box, fresh);
			return;
		}
		// A rewrite (compaction, a retry that restarted the answer): whole, no animation.
		source.current = text;
		box.innerHTML = renderMarkdown(text);
		const fresh = document.createElement("span");
		fresh.className = "tail";
		tail.current = fresh;
		placeTail(box, fresh);
	}, [text]);

	return (
		<div className="text markdown">
			<div className="settled" ref={settled} data-testid="stream-text" />
		</div>
	);
}
