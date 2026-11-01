/**
 * Following the end of the transcript: state, not animation. Ported from sibling's `packages/web/src/scroll.ts`.
 *
 * `pinned` is the whole state — true while the reader sits at the end and wants new output to pull the view
 * along, false the moment they move up even a pixel. Our own follow-scrolls only ever increase scrollTop, so an
 * upward move the browser did not make by shrinking content is the reader's doing (wheel, touch, keys, scrollbar
 * drag, selection drag); landing back at the end re-pins. Content changes are watched with ResizeObserver instead
 * of being hooked to messages, and following writes scrollTop instantly — gliding toward a target that keeps
 * moving lags, wobbles and reports its own scroll events back to us. The one exception is the reader's own send:
 * `glide` animates, because there the target is a message that has not arrived yet rather than a stream arriving
 * under a still view.
 */
import { type RefObject, useEffect, useRef } from "react";

export interface ScrollSample {
	top: number;
	height: number;
}

/**
 * The pin decision after a scroll event. Content shrinking lowers scrollTop by itself; any other upward move is
 * the reader leaving the end.
 */
export function pinnedAfterScroll(
	wasPinned: boolean,
	previous: ScrollSample,
	next: ScrollSample,
	atEnd: boolean,
): boolean {
	if (next.top < previous.top - 0.5 && next.height >= previous.height - 1) return false;
	if (atEnd) return true;
	return wasPinned;
}

export interface Follower {
	/** Re-pin and go to the end; smooth only for an explicit jump. */
	jump(smooth?: boolean): void;
	/** Re-pin and glide to the end, and keep gliding while the content that follows the reader's own message lands. */
	glide(): void;
	/** Re-check the end (content may have shrunk under an unpinned reader). */
	refresh(): void;
	/** Record a `<details>` the view opened itself, so its toggle is not read as reader intent. */
	markOpened(target: Element): void;
}

const AT_END_SLACK = 2;
/**
 * How long a glide's follow-scrolls stay smooth. Sending a message puts a row in the transcript a moment later, and
 * an instant write at that first growth stops the animation a few pixels in — the reader sees a jump, not a glide.
 * Short enough that the next turn's streaming, which must not animate, is back to instant writes.
 */
const GLIDE_MS = 600;

/** Mount the follower on a scrollable list; `onChange` reports the pin state for the jump pill. */
export function useFollower(list: RefObject<HTMLElement | null>, onChange: (pinned: boolean) => void): Follower {
	const pinned = useRef(true);
	const lastTop = useRef(0);
	const lastHeight = useRef(0);
	// True while a touch or the momentum it started is still moving the list.
	const touchOwned = useRef(false);
	/** Wall clock until which follow-scrolls are animated; see `GLIDE_MS`. */
	const glideUntil = useRef(0);
	const touchTimer = useRef<number | undefined>(undefined);
	const openedByUs = useRef(new WeakSet<Element>());
	// The mount effect reads the latest callback without depending on its identity.
	const notify = useRef(onChange);
	notify.current = onChange;

	useEffect(() => {
		const element = list.current;
		if (element === null) return;

		const atEnd = (): boolean => element.scrollHeight - element.clientHeight - element.scrollTop <= AT_END_SLACK;

		const stickToEnd = (): void => {
			// A finger (or the momentum it started) owns the list: writing scrollTop mid-fling fights the momentum.
			if (touchOwned.current) return;
			if (Date.now() < glideUntil.current) {
				element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
				return;
			}
			element.scrollTop = element.scrollHeight;
		};

		const setPinned = (next: boolean): void => {
			if (next === pinned.current) return;
			pinned.current = next;
			notify.current(next);
		};

		const followContent = (): void => {
			if (pinned.current) stickToEnd();
			// Content can shrink under an unpinned reader (a collapsed trace) and land them back at the end.
			else if (atEnd()) setPinned(true);
		};

		/* ---------- what counts as content ---------- */

		// The boxes whose size means "the content changed": the list's children and the children of any
		// `display: contents` wrapper (the live slot has no box of its own, so observing it never fires).
		const contentBoxes = (): Element[] => {
			const boxes: Element[] = [];
			const visit = (parent: Element): void => {
				for (const child of parent.children) {
					boxes.push(child);
					if (getComputedStyle(child).display === "contents") visit(child);
				}
			};
			visit(element);
			return boxes;
		};

		const observer = new ResizeObserver(followContent);
		const watched = new Set<Element>();
		const watchContent = (): void => {
			for (const box of contentBoxes()) {
				if (watched.has(box)) continue;
				watched.add(box);
				observer.observe(box);
			}
			for (const box of [...watched]) {
				if (box.isConnected) continue;
				watched.delete(box);
				observer.unobserve(box);
			}
			followContent();
		};
		const mutations = new MutationObserver(watchContent);
		mutations.observe(element, { childList: true, subtree: true });
		observer.observe(element);
		window.visualViewport?.addEventListener("resize", followContent);
		watchContent();

		/* ---------- reader intent ---------- */

		const onScroll = (): void => {
			const next = { top: element.scrollTop, height: element.scrollHeight };
			setPinned(
				pinnedAfterScroll(pinned.current, { top: lastTop.current, height: lastHeight.current }, next, atEnd()),
			);
			lastTop.current = next.top;
			lastHeight.current = next.height;
		};
		const onToggle = (event: Event): void => {
			if (openedByUs.current.has(event.target as Element)) return;
			const target = event.target;
			// Opening a trace grows the content below the fold: that is the reader's doing, not new output,
			// so it must never drag the view to the end.
			if (!(target instanceof HTMLDetailsElement) || target.open) {
				setPinned(false);
				return;
			}
			// Closing shrinks it, which can land an unpinned reader on the end without a scroll event.
			followContent();
		};
		const onTouchStart = (): void => {
			touchOwned.current = true;
			clearTimeout(touchTimer.current);
		};
		const releaseTouchSoon = (delay: number): void => {
			clearTimeout(touchTimer.current);
			touchTimer.current = window.setTimeout(() => {
				touchOwned.current = false;
			}, delay);
		};
		const onTouchEnd = (): void => releaseTouchSoon(180);
		const onScrollEnd = (): void => {
			clearTimeout(touchTimer.current);
			touchOwned.current = false;
			if (pinned.current) stickToEnd();
		};

		element.addEventListener("scroll", onScroll);
		element.addEventListener("toggle", onToggle, true);
		element.addEventListener("touchstart", onTouchStart, { passive: true });
		element.addEventListener("touchend", onTouchEnd, { passive: true });
		element.addEventListener("touchcancel", onTouchEnd, { passive: true });
		element.addEventListener("scrollend", onScrollEnd);

		return () => {
			element.removeEventListener("scroll", onScroll);
			element.removeEventListener("toggle", onToggle, true);
			element.removeEventListener("touchstart", onTouchStart);
			element.removeEventListener("touchend", onTouchEnd);
			element.removeEventListener("touchcancel", onTouchEnd);
			element.removeEventListener("scrollend", onScrollEnd);
			window.visualViewport?.removeEventListener("resize", followContent);
			mutations.disconnect();
			observer.disconnect();
			clearTimeout(touchTimer.current);
		};
	}, [list]);

	return {
		jump(smooth = false): void {
			const element = list.current;
			if (element === null) return;
			pinned.current = true;
			notify.current(true);
			if (smooth) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
			else element.scrollTop = element.scrollHeight;
		},
		glide(): void {
			const element = list.current;
			if (element === null) return;
			pinned.current = true;
			notify.current(true);
			glideUntil.current = Date.now() + GLIDE_MS;
			element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
		},
		refresh(): void {
			const element = list.current;
			if (element === null) return;
			if (pinned.current) element.scrollTop = element.scrollHeight;
			else if (element.scrollHeight - element.clientHeight - element.scrollTop <= AT_END_SLACK) {
				pinned.current = true;
				notify.current(true);
			}
		},
		markOpened(target: Element): void {
			openedByUs.current.add(target);
		},
	};
}
