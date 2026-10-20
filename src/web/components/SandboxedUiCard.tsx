/**
 * The inline widget renderer for `generateSandboxedUi`, adapted from
 * `vendor/open-intelligent-ui/apps/app/src/components/generative-ui/open-generative-ui/renderer.tsx`.
 *
 * A call moves through three phases, and each one is meant to look deliberate rather than half-built:
 *
 * 1. `placeholder` — the arguments are still arriving. A skeleton, the model's own progress phrases, and the
 *    height the model estimated: the card must not resize on every delta.
 * 2. `preview` — the css is complete and markup is arriving. A second sandbox morphs the partial body into place
 *    and measures itself, and the frame may only *grow*: content that appeared is real, content that a morph
 *    dropped is an artifact. Without measurement the preview would sit at the estimate and crop the widget.
 * 3. `settled` — the call is committed. The complete document (CSP, importmap, design-system styles) replaces the
 *    preview with a crossfade, so the card never blanks out between the two, and its own measurement decides the
 *    height, shrink included.
 *
 * Behavior (`jsFunctions`, `jsExpressions`) only reaches the sandbox once settled: a half-streamed function
 * declaration would throw inside the iframe.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IDIOMORPH_JS } from "../lib/idiomorph-inline.ts";
import {
	buildFinalFrameContent,
	buildPreviewBodyMorph,
	buildPreviewHeadContent,
	EMBEDDED_FRAME_JS,
	FULLSCREEN_FRAME_JS,
	MEASUREMENT_JS,
	PREVIEW_FRAME_CONTENT,
	PREVIEW_MEASUREMENT_JS,
	RESIZE_MESSAGE_TYPE,
} from "../lib/frame-content.ts";
import {
	CONTENT_MAX,
	clampHeight,
	mergeMeasuredHeight,
	placeholderHeight,
	streamingCeiling,
} from "../lib/frame-height.ts";
import type { OpenGenUIContent } from "../../shared/genui-content.ts";
import { extractCompleteStyles, processPartialHtml } from "../lib/process-partial-html.ts";
import { loadWebsandbox, type SandboxInstance, type WidgetBridge } from "../lib/websandbox-loader.ts";

/** One frame update per second while streaming: the widget is a preview, not a live console. */
export const THROTTLE_MS = 1000;
/** How long a progress phrase stays up before the next one. */
const PHRASE_MS = 2600;
/** Matches the frame's opacity transition in chat.css; the preview is dropped once it has faded out. */
const CROSSFADE_MS = 200;

export const FALLBACK_PHRASES = [
	"Sketching pixels",
	"Wiring up nodes",
	"Painting gradients",
	"Compiling visuals",
];

/** Re-exported for the frame's own tests: the ceiling on a reported height. */
export function clampReportedHeight(height: unknown): number | null {
	return clampHeight(height, CONTENT_MAX, 50);
}

function shouldFlushImmediately(previous: OpenGenUIContent | null, next: OpenGenUIContent): boolean {
	if (next.cssComplete && (previous === null || previous.cssComplete !== true)) return true;
	if (next.htmlComplete) return true;
	if (next.generating === false) return true;
	if (next.jsFunctions !== undefined && (previous === null || previous.jsFunctions === undefined)) return true;
	if ((next.jsExpressions?.length ?? 0) > (previous?.jsExpressions?.length ?? 0)) return true;
	if ((next.html?.length ?? 0) > 0 && (previous?.html?.length ?? 0) === 0) return true;
	return false;
}

function styleIframe(iframe: HTMLIFrameElement, role: "preview" | "final"): void {
	iframe.style.width = "100%";
	iframe.style.height = "100%";
	iframe.style.border = "none";
	iframe.style.backgroundColor = "transparent";
	iframe.dataset.role = role;
	iframe.title = role === "final" ? "Interactive widget" : "Widget preview";
}

/**
 * The height a widget last reported, per call, kept outside React.
 *
 * A widget is mounted twice: once in the live turn while the call streams, and again as a settled entry. The second
 * mount is a fresh sandbox — the iframe cannot survive being re-parented — so without this the card would collapse
 * to the model's estimate for the half second the new sandbox needs, right as the answer lands.
 */
const MEASURED_HEIGHTS = new Map<string, number>();
const HEIGHT_CACHE_LIMIT = 64;

function cachedHeight(callId: string): number | null {
	return MEASURED_HEIGHTS.get(callId) ?? null;
}

function cacheHeight(callId: string, height: number): void {
	MEASURED_HEIGHTS.delete(callId);
	MEASURED_HEIGHTS.set(callId, height);
	while (MEASURED_HEIGHTS.size > HEIGHT_CACHE_LIMIT) {
		const oldest = MEASURED_HEIGHTS.keys().next();
		if (oldest.done === true) break;
		MEASURED_HEIGHTS.delete(oldest.value);
	}
}

export interface SandboxedUiCardProps {
	/** The tool call this card renders; identifies the height cache across the live and settled mounts. */
	callId: string;
	content: OpenGenUIContent;
	bridge: WidgetBridge;
	/** `true` while the model is still streaming the call; parts of `content` are then incomplete. */
	streaming: boolean;
	/** `true` while the card fills the screen: the widget owns the viewport and scrolls itself. */
	fullscreen?: boolean;
}

export function SandboxedUiCard({ callId, content, bridge, streaming, fullscreen }: SandboxedUiCardProps) {

	const [throttled, setThrottled] = useState(content);
	const [previous, setPrevious] = useState(content);
	const latest = useRef(content);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Synchronous state adjustment during render, as in the adapted component: immediate flushes reach the
	// sandbox in the same pass.
	if (content !== previous) {
		setPrevious(content);
		if (shouldFlushImmediately(throttled, content)) setThrottled(content);
	}

	useEffect(() => {
		latest.current = content;
	});

	const flush = useCallback(() => {
		timer.current = null;
		setThrottled(latest.current);
	}, []);

	useEffect(() => {
		if (throttled === content) {
			if (timer.current !== null) {
				clearTimeout(timer.current);
				timer.current = null;
			}
			return;
		}
		if (timer.current === null) timer.current = setTimeout(flush, THROTTLE_MS);
	}, [content, throttled, flush]);

	useEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current);
		},
		[],
	);

	return (
		<SandboxedUiFrame callId={callId} content={throttled} bridge={bridge} streaming={streaming} fullscreen={fullscreen} />
	);
}

type SandboxState = "idle" | "creating" | "ready" | "failed";
type Phase = "placeholder" | "preview" | "settled";

/** The phrases the model wrote, or a generic cycle when it wrote none. */
function phrasesOf(content: OpenGenUIContent): readonly string[] {
	const phrases = (content.placeholderMessages ?? []).filter((phrase) => phrase.trim() !== "");
	return phrases.length === 0 ? FALLBACK_PHRASES : phrases;
}

function SandboxedUiFrame({ callId, content, bridge, streaming, fullscreen }: SandboxedUiCardProps) {
	/** Placeholder height: the model's estimate, clamped, and only used until something measures itself. */
	const estimate = placeholderHeight(content.initialHeight);
	// The bridge is rebuilt on every parent render, so the sandbox holds a stable forwarder instead: a changing
	// `localApi` identity would tear the iframe down and lose the widget's own state.
	const bridgeRef = useRef(bridge);
	bridgeRef.current = bridge;
	const stableBridge = useRef<WidgetBridge>({
		sendPrompt: (args) => bridgeRef.current.sendPrompt(args),
		openLink: (args) => bridgeRef.current.openLink(args),
	}).current;
	const [phase, setPhase] = useState<Phase>("placeholder");
	const [previewHeight, setPreviewHeight] = useState<number | null>(null);
	// A remounted card starts at the height its widget last reported, so the box does not jump on the second mount.
	const [settledHeight, setSettledHeight] = useState<number | null>(() => cachedHeight(callId));
	const remembered = settledHeight !== null;
	const [sandboxState, setSandboxState] = useState<SandboxState>("idle");
	const [phraseIndex, setPhraseIndex] = useState(0);
	const fullscreenRef = useRef(fullscreen === true);
	fullscreenRef.current = fullscreen === true;

	const localApi = useMemo(() => {
		const api: Record<string, (args: unknown) => unknown> = {};
		api.sendPrompt = (args) => stableBridge.sendPrompt(args as { text: string });
		api.openLink = (args) => stableBridge.openLink(args as { url: string });
		return api;
	}, [stableBridge]);

	const fullHtml =
		content.htmlComplete === true && (content.html?.length ?? 0) > 0 ? content.html?.join("") : undefined;
	const css = content.cssComplete === true ? content.css : undefined;

	const cssReady = content.cssComplete === true;
	const partialHtml =
		content.htmlComplete !== true && (content.html?.length ?? 0) > 0 ? content.html?.join("") : undefined;
	const previewBody = partialHtml === undefined ? undefined : processPartialHtml(partialHtml);
	const previewStyles = partialHtml === undefined ? "" : extractCompleteStyles(partialHtml);
	const hasPreview = cssReady && (previewBody?.trim().length ?? 0) > 0;

	const containerRef = useRef<HTMLDivElement>(null);
	const finalSandbox = useRef<SandboxInstance | null>(null);
	const previewSandbox = useRef<SandboxInstance | null>(null);
	const previewReady = useRef(false);
	const finalReady = useRef(false);
	const executedExpressions = useRef(0);
	const pending = useRef<string[]>([]);
	const jsFunctionsInjected = useRef(false);

	// Every report lands here: `preview` grows the frame, `final` decides it. Heights arrive as numbers from the
	// iframe's own `body.scrollHeight`, which a hostile widget could lie about, hence the clamp.
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const data = event.data as { type?: string; role?: string; height?: unknown } | null;
			if (data?.type !== RESIZE_MESSAGE_TYPE) return;
			// Fullscreen ignores the content height: the frame is the viewport.
			if (fullscreenRef.current) return;
			const fromPreview = previewSandbox.current?.iframe.contentWindow === event.source;
			const fromFinal = finalSandbox.current?.iframe.contentWindow === event.source;
			if (!fromPreview && !fromFinal) return;
			if (fromPreview) {
				setPreviewHeight((current) =>
					// The first report starts from the estimate: a preview whose body has barely begun is not
					// grounds for shrinking the card to a sliver.
					mergeMeasuredHeight(current ?? estimate, data.height, {
						growOnly: true,
						max: Math.min(streamingCeiling(window.innerHeight), CONTENT_MAX),
					}),
				);
				return;
			}
			setSettledHeight((current) => {
				const next = mergeMeasuredHeight(current, data.height, { growOnly: false, max: CONTENT_MAX });
				if (next !== null) cacheHeight(callId, next);
				return next;
			});
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [callId, estimate]);

	// Preview sandbox: created once css is complete and some markup exists.
	useEffect(() => {
		const container = containerRef.current;
		if (container === null || fullHtml !== undefined || !hasPreview || previewSandbox.current !== null) return;
		let cancelled = false;
		loadWebsandbox()
			.then((Websandbox) => {
				if (cancelled) return;
				const sandbox = Websandbox.create(
					{},
					{ frameContainer: container, frameContent: PREVIEW_FRAME_CONTENT, allowAdditionalAttributes: "" },
				);
				previewSandbox.current = sandbox;
				styleIframe(sandbox.iframe, "preview");
				setPhase("preview");
				sandbox.promise.then(() => {
					if (cancelled) return;
					previewReady.current = true;
					sandbox.run(IDIOMORPH_JS);
					sandbox.run(
						`document.head.innerHTML = ${JSON.stringify(buildPreviewHeadContent(css, previewStyles))}`,
					);
					if (previewBody !== undefined) sandbox.run(buildPreviewBodyMorph(previewBody));
					// Only now does the preview know how tall it is; before this it would report zero.
					void sandbox.run(PREVIEW_MEASUREMENT_JS);
				});
			})
			.catch((error: unknown) => console.error("[gen-ui] preview sandbox failed:", error));
		return () => {
			cancelled = true;
		};
	}, [hasPreview, fullHtml]); // eslint-disable-line react-hooks/exhaustive-deps

	// Preview updates: the head follows css, the body is morphed.
	useEffect(() => {
		const sandbox = previewSandbox.current;
		if (sandbox === null || !previewReady.current) return;
		sandbox.run(`document.head.innerHTML = ${JSON.stringify(buildPreviewHeadContent(css, previewStyles))}`);
		if (previewBody !== undefined) sandbox.run(buildPreviewBodyMorph(previewBody));
	}, [previewBody, previewStyles, css]);

	// Final sandbox: the complete document, with the host bridge. The preview stays up underneath until this one
	// has reported a height, so the card crossfades instead of blinking through an empty frame.
	useEffect(() => {
		const container = containerRef.current;
		if (container === null || fullHtml === undefined) return;
		let cancelled = false;
		let dropPreview: ReturnType<typeof setTimeout> | null = null;
		executedExpressions.current = 0;
		jsFunctionsInjected.current = false;
		finalReady.current = false;
		pending.current = [];
		setSandboxState("creating");

		loadWebsandbox()
			.then((Websandbox) => {
				if (cancelled) return;
				const sandbox = Websandbox.create(localApi, {
					frameContainer: container,
					frameContent: buildFinalFrameContent(fullHtml, css),
					allowAdditionalAttributes: "",
				});
				finalSandbox.current = sandbox;
				styleIframe(sandbox.iframe, "final");
				sandbox.promise.then(() => {
					if (cancelled) return;
					finalReady.current = true;
					setSandboxState("ready");
					sandbox.run(MEASUREMENT_JS);
					const queued = pending.current;
					pending.current = [];
					void (async () => {
						for (const code of queued) await sandbox.run(code);
					})();
					// Settled: the final frame fades in, the preview fades out and is destroyed.
					setPhase("settled");
					dropPreview = setTimeout(() => {
						previewSandbox.current?.destroy();
						previewSandbox.current = null;
						previewReady.current = false;
					}, CROSSFADE_MS);
				});
			})
			.catch((error: unknown) => {
				setSandboxState("failed");
				console.error("[gen-ui] final sandbox failed:", error);
			});

		return () => {
			cancelled = true;
			if (dropPreview !== null) clearTimeout(dropPreview);
			finalSandbox.current?.destroy();
			finalSandbox.current = null;
			finalReady.current = false;
			previewSandbox.current?.destroy();
			previewSandbox.current = null;
			previewReady.current = false;
			setSettledHeight(null);
			setPreviewHeight(null);
		};
	}, [fullHtml, css, localApi]);

	// Behavior: injected once the final sandbox is ready, queued before it.
	useEffect(() => {
		if (content.jsFunctions === undefined || jsFunctionsInjected.current) return;
		jsFunctionsInjected.current = true;
		const sandbox = finalSandbox.current;
		if (finalReady.current && sandbox !== null) {
			void sandbox.run(content.jsFunctions).catch((error: unknown) => {
				console.error("[gen-ui] behavior failed:", error);
			});
		} else pending.current.push(content.jsFunctions);
	}, [content.jsFunctions]);

	// Expressions: run in arrival order, each awaited.
	useEffect(() => {
		const expressions = content.jsExpressions;
		if (expressions === undefined || expressions.length === 0) return;
		const start = executedExpressions.current;
		if (start >= expressions.length) return;
		const next = expressions.slice(start);
		executedExpressions.current = expressions.length;
		const sandbox = finalSandbox.current;
		if (finalReady.current && sandbox !== null) {
			void (async () => {
				for (const expression of next) await sandbox.run(expression);
			})();
		} else {
			pending.current.push(...next);
		}
	}, [content.jsExpressions]);

	// The embedded layout pins the content height; fullscreen hands the viewport to the widget instead. Keyed on
	// the phase, so a widget that is expanded mid-stream gets the viewport rule on whichever sandbox is up, and
	// again on the final one when it takes over.
	useEffect(() => {
		if (phase === "placeholder") return;
		const sandbox = finalSandbox.current ?? previewSandbox.current;
		if (sandbox === null) return;
		void sandbox.run(fullscreen === true ? FULLSCREEN_FRAME_JS : EMBEDDED_FRAME_JS).catch((error: unknown) => {
			console.error("[gen-ui] layout switch failed:", error);
		});
		// Entering fullscreen makes the last embedded measurement stale; the widget reports a fresh one on exit.
		if (fullscreen === true) setSettledHeight(null);
	}, [fullscreen, phase]);

	// The progress phrases the model wrote; cycling them is the only sign of life until markup arrives.
	//
	// Two mounts do not want a skeleton: one whose document is already on the way (a call that settled while it was
	// being written) and one that has rendered before (the settle re-mount). Both keep the frame at its known
	// height and let the widget fade in, which is the whole of the artifact left by an iframe that cannot be
	// re-parented.
	const phrases = phrasesOf(content);
	const showPlaceholder = phase === "placeholder" && fullHtml === undefined && !remembered;
	useEffect(() => {
		if (!showPlaceholder || phrases.length < 2) return;
		const timer = setInterval(() => setPhraseIndex((index) => (index + 1) % phrases.length), PHRASE_MS);
		return () => clearInterval(timer);
	}, [showPlaceholder, phrases.length]);

	// Height: the settled document wins, then the streaming preview, then the estimate.
	const height = settledHeight ?? previewHeight ?? estimate;
	const frameHeight = fullscreen === true ? "100%" : `${height}px`;

	return (
		<div className="genui">
			<div className="genui-toolbar" data-testid="genui-status">
				<span className="badge">{streaming ? "GEN-UI • streaming" : "GEN-UI • settled"}</span>
				<span className="genui-hint">{`estimate ${estimate}px · ${height}px · ${phase}`}</span>
			</div>
			<div
				ref={containerRef}
				className="genui-frame"
				data-testid="genui-frame"
				data-phase={phase}
				data-sandbox-state={sandboxState}
				style={{ height: frameHeight }}
			>
				{showPlaceholder ? (
					<div className="genui-loading" data-testid="genui-loading">
						<div className="genui-skeleton" aria-hidden="true">
							<span />
							<span />
							<span />
						</div>
						<p className="genui-phrase" key={phraseIndex} data-testid="genui-phrase">
							{phrases[phraseIndex % phrases.length] ?? FALLBACK_PHRASES[0]}
							<span className="genui-dots" aria-hidden="true" />
						</p>
					</div>
				) : null}
			</div>
		</div>
	);
}
