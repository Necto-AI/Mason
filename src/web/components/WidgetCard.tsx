/**
 * A `generateSandboxedUi` call in the flow: bare, at the position the call has in the bubble, in live turns and
 * settled ones alike. The card itself is the adapted OpenIntelligentUI renderer; this places it and gives it the
 * screen when the widget is meant to be used rather than glanced at.
 *
 * The card carries one strip of its own chrome above the sandbox; the control sits there rather than floating over
 * the widget, where it covered whatever the widget had put in its own top-right corner.
 *
 * Fullscreen keeps the card where it is: the wrapper switches to a fixed, viewport-filling box, so the sandbox and
 * everything the reader did inside it survive. The browser's own fullscreen is requested on top of that when it is
 * available, and the overlay stands on its own where it is not (iOS Safari has no element fullscreen).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpenGenUIContent } from "../../shared/genui-content.ts";
import type { WidgetBridge } from "../lib/websandbox-loader.ts";
import { SandboxedUiCard } from "./SandboxedUiCard.tsx";

export interface WidgetCardProps {
	readonly callId: string;
	/** The artifact, mapped server-side: the client never receives the call's arguments. */
	readonly content: unknown;
	readonly streaming: boolean;
	readonly bridgeFor: (callId: string) => WidgetBridge;
}

export function WidgetCard({ callId, content: raw, streaming, bridgeFor }: WidgetCardProps) {
	const [fullscreen, setFullscreen] = useState(false);
	const wrapper = useRef<HTMLDivElement | null>(null);
	// The bridge and the content keep their identity per call, so a parent render never restarts the sandbox.
	const bridge = useMemo(() => bridgeFor(callId), [bridgeFor, callId]);
	const content = raw as OpenGenUIContent;

	const exit = useCallback((): void => {
		setFullscreen(false);
		// The overlay is ours; the browser's own fullscreen is not, so it has to be left explicitly.
		if (document.fullscreenElement !== null) void document.exitFullscreen().catch(() => {});
	}, []);

	useEffect(() => {
		if (!fullscreen) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") exit();
		};
		// Leaving the browser's fullscreen (Esc, F11, the system UI) leaves the overlay too.
		const onFullscreenChange = (): void => {
			if (document.fullscreenElement === null) setFullscreen(false);
		};
		window.addEventListener("keydown", onKey);
		document.addEventListener("fullscreenchange", onFullscreenChange);
		// The transcript's bottom fade is a mask, and a mask clips positioned descendants: drop it while the
		// overlay is up, so the widget is not cut off at the viewport edge.
		document.body.classList.add("widget-fullscreen");
		return () => {
			window.removeEventListener("keydown", onKey);
			document.removeEventListener("fullscreenchange", onFullscreenChange);
			document.body.classList.remove("widget-fullscreen");
		};
	}, [fullscreen, exit]);

	const toggle = useCallback(() => {
		if (fullscreen) {
			exit();
			return;
		}
		setFullscreen(true);
		const element = wrapper.current;
		if (element !== null && document.fullscreenEnabled) {
			// Not awaited: the overlay stands on its own, and a refusal is not worth an error banner.
			void element.requestFullscreen?.().catch(() => {});
		}
	}, [fullscreen, exit]);

	return (
		<div
			ref={wrapper}
			className={`widget${fullscreen ? " fullscreen" : ""}`}
			data-testid="widget"
			data-call-id={callId}
			data-fullscreen={fullscreen}
		>
			{/* Reserve the strip: the control lives outside the widget, so it never covers its own content. */}
			<div className="widget-head">
				<button
					type="button"
					className="widget-action"
					data-testid="widget-fullscreen"
					aria-pressed={fullscreen}
					aria-label={fullscreen ? "Exit widget fullscreen" : "Use this widget fullscreen"}
					title={fullscreen ? "Exit fullscreen" : "Use this widget fullscreen"}
					onClick={toggle}
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth={2}
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						{fullscreen ? (
							<>
								<path d="M9 3H5a2 2 0 0 0-2 2v4" />
								<path d="M15 3h4a2 2 0 0 1 2 2v4" />
								<path d="M15 21h4a2 2 0 0 0 2-2v-4" />
								<path d="M9 21H5a2 2 0 0 1-2-2v-4" />
							</>
						) : (
							<>
								<path d="M15 3h6v6" />
								<path d="M9 21H3v-6" />
								<path d="M21 3l-7 7" />
								<path d="M3 21l7-7" />
							</>
						)}
					</svg>
					<span>{fullscreen ? "Exit" : "Fullscreen"}</span>
				</button>
			</div>
			<SandboxedUiCard
				callId={callId}
				content={content}
				bridge={bridge}
				streaming={streaming}
				fullscreen={fullscreen}
			/>
		</div>
	);
}
